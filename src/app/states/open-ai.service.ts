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
}

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

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
    })
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

    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'post',
      headers: new Headers({
        // https://platform.openai.com/account/usage
        Authorization: `Bearer ${this.currentState.settings.apiKey}`,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        model: this.currentState.selectedModel.id,
        messages: messages,
        stream: true,
      }),
    }).then(async (response) => {
      if (!response.body) {
        console.warn('empty body');
        recognizer.complete();
        return;
      }

      recognizer.setInitialDelay(Date.now() - t0);

      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      if (!reader) {
        console.warn('empty reader');
        recognizer.complete();
        return;
      }

      let done = false, completion = '';

      do {
        const { value, done } = await reader.read();
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

  async getModels(openai: OpenAIApi) {
    // This triggers a "Refused to set unsafe header" error because
    // https://github.com/openai/openai-node/issues/6
    const result = await openai.listModels();
    return result.data.data.filter((d) => d.owned_by === 'openai');
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
    const model = (await firstValueFrom(this.state$)).selectedModel?.id ?? '';
    const cost = 
    model.startsWith('gpt-4')
    ? 0.03 * promptTokens / 1000 + 0.06 * completionTokens / 1000
    : 0.002 * promptTokens / 1000 + 0.002 * completionTokens / 1000;
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
      };
    }

    const openai = await this.apiCache.getOrCreate(key, () => {
      const configuration = new Configuration({
        apiKey: key!,
      });
      return new OpenAIApi(configuration);
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


    this.currentState = {
      ready: model !== null,
      selectedModel: model,
      settings: { apiKey: key },
      managed: !!managedSettings,
      rolePlayScript: rolePlay,
      openai,
      error,
      models,
    };
    return this.currentState;
  }
}
