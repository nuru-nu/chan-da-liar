import { Injectable } from '@angular/core';
import { Configuration, Model, OpenAIApi } from 'openai';
import { ConfigService } from '../config.service';
import {
  BehaviorSubject,
  combineLatest,
  debounceTime,
  firstValueFrom,
  mergeMap,
  shareReplay,
} from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';
import { Cache } from '../utils/cache';
import {
  createOngoingRecognizer,
  OngoingRecognition,
} from './ongoing-recognizer';
import { FirebaseService, LoginState } from './firebase.service';

export interface OpenAISettings {
  apiKey: string;
}

export interface OpenAIState {
  settings: OpenAISettings | null;
  managed: boolean | null;

  rolePlayScript: string | null;
  openai: OpenAIApi | null;
  models: Model[];
  selectedModel: Model | null;
  ready: boolean;
  error: string | null;
  props: string | null;
}

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const OAI_BASE_URL = 'https://api.openai.com/v1';
// https://github.com/ggerganov/llama.cpp/blob/master/examples/server/README.md
const LLAMA_CPP_BASE_URL = 'http://127.0.0.1:8000';
// https://github.com/ollama/ollama/blob/main/docs/api.md
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const LLAMA_CPP_PREFIX = 'llama.cpp:';
const OLLAMA_PREFIX = 'ollama:';

@Injectable({
  providedIn: 'root',
})
export class OpenAiService {
  private configApiKey = 'openai-api';
  private configRolePlayKey = 'openai-roleplay';
  private configModelKey = 'openai-model';
  private totalCostKey = 'openai-total-cost';

  private modalCache = new Cache<Model[]>();
  private apiCache = new Cache<OpenAIApi>();

  totalCost = this.config.watch<number>(this.totalCostKey, 0);

  private managedSettings = new BehaviorSubject<OpenAISettings|null>(null);
  private currentState: OpenAIState|null = null;
  state$ = combineLatest([
    this.config.watch<string>(this.configApiKey).pipe(debounceTime(500)),
    this.config.watch<string>(this.configRolePlayKey).pipe(debounceTime(500)),
    this.config.watch<string>(this.configModelKey),
    this.managedSettings,
  ]).pipe(
    mergeMap(([api, rolePlay, model, managedSettings]) =>
      fromPromise(this.mapState(api, rolePlay, model, managedSettings)),
    ),
    shareReplay(1),
  );
  private modelProps = new Map<string, string>();

  constructor(private config: ConfigService, private firebase: FirebaseService) {
    this.firebase.loginState.subscribe(async (loginState: LoginState) => {
      if (loginState === 'success') {
        const totalCost = await this.firebase.getTotalCost();
        if (totalCost) {
          this.config.save(this.totalCostKey, totalCost);
        }
        const config = await firebase.getConfig();
        if (config) {
          this.managedSettings.next({
            apiKey: config.openaiApiKey,
          });
        }
      } else {
        this.managedSettings.next(null);
      }
    });
  }

  private idWithoutPrefix(model: Model) {
    if (model.id.startsWith(LLAMA_CPP_PREFIX)) return model.id.substring(LLAMA_CPP_PREFIX.length);
    if (model.id.startsWith(OLLAMA_PREFIX)) return model.id.substring(OLLAMA_PREFIX.length);
    return model.id;
  }

  private getOpenAiBase(model: Model) {
    if (model.id.startsWith(LLAMA_CPP_PREFIX)) return LLAMA_CPP_BASE_URL;
    if (model.id.startsWith(OLLAMA_PREFIX)) return `${OLLAMA_BASE_URL}/v1`;
    return OAI_BASE_URL;
  }

  private getExtraArgs(model: Model) {
    // TODO: The llama.cpp server should be queried periodically to avoid lag
    // (maybe ollama as well, but it's less of a problem)
    if (model.id.startsWith(LLAMA_CPP_PREFIX)) return {cache_prompt: true};
    return {};
  }

  async prompt(messages: PromptMessage[]): Promise<OngoingRecognition> {
    const recognizer = createOngoingRecognizer({
      role: 'assistant',
      textPrefix: undefined,
    });
    const t0 = Date.now();

    if (!this.currentState?.settings || !this.currentState?.selectedModel) {
      console.warn('no model/apiKey');
      recognizer.complete();
      return recognizer.recognition();
    }

    fetch(`${this.getOpenAiBase(this.currentState.selectedModel)}/chat/completions`, {
      method: 'post',
      headers: new Headers({
        // https://platform.openai.com/account/usage
        Authorization: `Bearer ${this.currentState.settings.apiKey}`,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        model: this.idWithoutPrefix(this.currentState.selectedModel),
        messages: messages,
        stream: true,
        ...this.getExtraArgs(this.currentState.selectedModel),
      }),
    }).then(async (response) => {
      if (!response.body) {
        console.warn('empty body');
        recognizer.complete();
        return;
      }

      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      if (!reader) {
        console.warn('empty reader');
        recognizer.complete();
        return;
      }

      let done = false, completion = '';

      let initialDelayMs = 0;
      do {
        const { value, done } = await reader.read();
        if (!initialDelayMs) {
          initialDelayMs = Date.now() - t0;
          recognizer.setInitialDelay(initialDelayMs);
        }
        if (done) break;
        for (const line of value.split(/\n\n/g)) {
          if (!line.startsWith('data: ')) continue;
          const data = line.replace(/^data: /, '');
          completion += data;
          if (data !== '[DONE]') {
            const d = JSON.parse(data);
            const delta = d.choices[0].delta.content;
            if (delta) {
              recognizer.append(delta);
            }
          }
        }
      } while (!done);

      recognizer.complete();

      const oldCost = this.config.get<number>(this.totalCostKey) ?? 0;
      const cost = await this.getCost(JSON.stringify(messages), completion);
      this.firebase.addCost(cost, 'openai');
      this.config.save(this.totalCostKey, oldCost + cost);
    }).catch(error => {
      recognizer.complete();
      console.log('Could not prompt openai', error);
    });

    return recognizer.recognition();
  }

  async getModels(openai: OpenAIApi): Promise<Model[]> {
    const [oaiModels, llamaCppProps, ollamaTags] = await Promise.allSettled([
      // This triggers a "Refused to set unsafe header" error because
      // https://github.com/openai/openai-node/issues/6
      openai.listModels(),
      fetch(`${LLAMA_CPP_BASE_URL}/props`),
      fetch(`${OLLAMA_BASE_URL}/api/tags`),
    ]);
    const models = [];
    if (oaiModels.status === 'fulfilled') {
      models.push(...oaiModels.value.data.data.filter(
          (d) => d.owned_by === 'openai' || d.owned_by === 'system'));
    } else {
      console.warn('Could not get OpenAi models', oaiModels);
    }
    if (llamaCppProps.status === 'fulfilled') {
      const props = await llamaCppProps.value.json();
      console.log('llama_cpp_tags', props);
      const path = props.default_generation_settings.model;
      const parts = path.split('/');
      const name = parts[parts.length - 2];
      const id = `${LLAMA_CPP_PREFIX}${name}`;
      models.push({id, object: '', created: 0, owned_by: 'llama.cpp'});
      this.modelProps.set(id, JSON.stringify(props));
    }
    if (ollamaTags.status === 'fulfilled') {
      const tags = await ollamaTags.value.json();
      console.log('ollama_tags', tags);
      for (const model of tags.models) {
        const id = `${OLLAMA_PREFIX}${model.name}`;
        models.push({id, object: '', created: 0, owned_by: 'ollama'});
        this.modelProps.set(id, JSON.stringify(model));
      }
    }
    return models;
  }

  formatProps(propsString: string) {
    try {
      const modelProps = JSON.parse(propsString);
      if ('default_generation_settings' in modelProps) {
        // llama.cpp
        const props = modelProps.default_generation_settings;
        const parts = props.model.split('/')
        const ckpt = parts[parts.length - 2];
        const n_ctx = props.n_ctx;
        const t = props.temperature.toFixed(2);
        const top_p = props.top_p.toFixed(2);
        const penalty = props.repeat_penalty.toFixed(1);
        return ` (${ckpt}, n_ctx=${n_ctx}, t=${t}, top_p=${top_p}, penalty=${penalty})`
      }
      if ('details' in modelProps) {
        // ollama
        const props = modelProps.details;
        return ` (${props.family}, ${props.parameter_size}, ${props.quantization_level})`;
      }
    } catch (err) {
      console.log('Cannot parse model props', propsString, err);
    }
    return null;
  }

  setKey(key: string) {
    this.config.save(this.configApiKey, key);
  }

  setModel(model: string) {
    this.config.save(this.configModelKey, model);
  }

  setRolePlay(script: string) {
    this.config.save(this.configRolePlayKey, script);
  }

  countTokens(text: string): number {
    const words = text.split(/\s+/g).length;
    // https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them
    return Math.round(words * 4 / 3);
  }

  async getCost(prompt: string, completion: string): Promise<number> {
    const promptTokens = this.countTokens(prompt);
    const completionTokens = this.countTokens(completion);
    // https://openai.com/pricing
    const costsPerToken  = {prompt: 0.002, completion: 0.002};
    if (this.currentState?.selectedModel) {
      if (this.currentState.selectedModel.id.startsWith('gpt-4')) {
        costsPerToken.prompt = 0.03;
        costsPerToken.completion = 0.06;
      } else if (
          this.currentState.selectedModel.id.startsWith(LLAMA_CPP_PREFIX) ||
          this.currentState.selectedModel.id.startsWith(OLLAMA_PREFIX)
      ) {
        costsPerToken.prompt = 0;
        costsPerToken.completion = 0;
      }
    }
    const cost = (
        costsPerToken.prompt * promptTokens / 1000 +
        costsPerToken.completion * completionTokens / 1000
    );
    // console.log('getCost', model, promptTokens, completionTokens, '->', cost);
    return cost;
  }

  async mapState(
    key: string | null,
    rolePlay: string | null,
    selectedModel: string | null,
    managedSettings: OpenAISettings | null,
  ): Promise<OpenAIState> {
    if (managedSettings) {
      key = managedSettings.apiKey!;
    }
    if (!key) {
      return {
        ready: false,
        models: [],
        selectedModel: null,
        rolePlayScript: rolePlay,
        settings: null,
        managed: false,
        openai: null,
        error: null,
        props: null,
      };
    }

    const openai = await this.apiCache.getOrCreate(key, () => {
      const configuration = new Configuration({
        apiKey: key!,
      });
      return new OpenAIApi(configuration, OAI_BASE_URL);
    });

    let error = '';
    const models = await this.modalCache.getOrCreate(key, () =>
      this.getModels(openai).catch((err) => {
        if (err.message === 'Request failed with status code 401') {
          error = 'Invalid api key or no permission/quota';
        } else {
          error = 'Failed to load OpenAI models';
        }
        return [];
      }),
    );
    const model = models.find((m) => m.id === selectedModel) ?? null;

    let props = this.modelProps.get(model?.id || '') || null;

    this.currentState = {
      ready: model !== null,
      selectedModel: model,
      settings: { apiKey: key },
      managed: !!managedSettings,
      rolePlayScript: rolePlay,
      openai,
      error,
      models,
      props,
    };
    return this.currentState;
  }
}
