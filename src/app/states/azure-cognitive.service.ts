import { Injectable } from '@angular/core';
import { ConfigService } from '../config.service';
import {
  OutputFormat,
  AudioConfig,
  SpeechRecognizer,
  SpeechConfig,
  SpeechSynthesisOutputFormat,
  SpeechSynthesizer,
  VoiceInfo,
  SpeakerAudioDestination,
} from 'microsoft-cognitiveservices-speech-sdk';
import { BehaviorSubject, combineLatest, debounceTime, mergeMap, shareReplay} from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';
import { Cache } from '../utils/cache';
import { FirebaseService } from './firebase.service';
import { Recording } from "./prerecording.service";

export interface AzureCognitiveSettings {
  apiKey: string;
  region: string;
}

export interface AugmentedSpeechConfig {
  speechConfig: SpeechConfig;
  rate: number;
  style: string | null;
  voiceShortName: string | null;
}

export interface AzureCognitiveState {
  speechConfig: AugmentedSpeechConfig | null;
  settings: AzureCognitiveSettings | null;
  managed: boolean;
  voices: VoiceInfo[];
  locales: string[];
  localeVoices: VoiceInfo[];
  localeFilter: boolean;
  selectedLocale: string | null;
  selectedVoice: VoiceInfo | null;
  selectedStyle: string | null;
  ready: boolean;
  error: string | null;
}

export interface SpeakResult {
  duration: number;
  visums: SpeakVisum[];
}

export interface SpeakVisum {
  value: number;
  offset: number;
}

const LOCALE_SELECTION = new Set([
  'en-US', 'en-GB', 'de-DE', 'de-CH',
]);

@Injectable({
  providedIn: 'root',
})
export class AzureCognitiveService {
  private configApiKey = 'azure-cognitive-key';
  private configRegionKey = 'azure-cognitive-region';
  private configLocaleFilterKey = 'azure-cognitive-locale-filter';
  private configLocaleKey = 'azure-cognitive-locale';
  private configVoiceKey = 'azure-cognitive-voice';
  private configRateKey = 'azure-cognitive-rate';
  private configStyleKey = 'azure-cognitive-style';

  private speakSuffixDuration = 750;

  private voiceCache = new Cache<VoiceInfo[]>();
  private speechCache = new Cache<SpeechConfig>();

  private managedSettings = new BehaviorSubject<AzureCognitiveSettings|null>(null);
  state$ = combineLatest([
    this.config.watch<string>(this.configApiKey).pipe(debounceTime(500)),
    this.config.watch<string>(this.configRegionKey).pipe(debounceTime(500)),
    this.config.watch<boolean>(this.configLocaleFilterKey),
    this.config.watch<string>(this.configLocaleKey),
    this.config.watch<string>(this.configVoiceKey),
    this.managedSettings,
    this.config.watch<number>(this.configRateKey),
    this.config.watch<string>(this.configStyleKey),
  ]).pipe(
    mergeMap(([apiKey, region, localeFilter, locale, voice, managedSettings, rate, style]) =>
      fromPromise(this.mapState(apiKey, region, localeFilter, locale, voice, managedSettings, rate, style)),
    ),
    shareReplay(1),
  );

  constructor(private config: ConfigService, firebase: FirebaseService) {
    firebase.loginState.subscribe(async (loginState) => {
      if (loginState === 'success') {
        const config = await firebase.getConfig();
        if (config) {
          this.managedSettings.next({
            apiKey: config.azureApiKey,
            region: config.azureRegion,
          });
        }
      } else {
        this.managedSettings.next(null);
      }
    })
  }

  setApiKey(key: string) {
    this.config.save(this.configApiKey, key);
  }

  setRegion(key: string) {
    this.config.save(this.configRegionKey, key);
  }

  setLocale(locale: string) {
    this.config.save(this.configLocaleKey, locale);
  }

  setVoice(voice: string) {
    this.config.save(this.configVoiceKey, voice);
  }

  setStyle(style: string) {
    this.config.save(this.configStyleKey, style);
  }

  setRate(rate: number) {
    this.config.save(this.configRateKey, rate);
  }

  setLocaleFilter(value: boolean) {
    this.config.save(this.configLocaleFilterKey, value);
  }

  async mapState(
    apiKey: string | null,
    region: string | null,
    localeFilter: boolean | null,
    locale: string | null,
    voice: string | null,
    managedSettings: AzureCognitiveSettings | null,
    rate: number | null,
    style: string | null,
  ): Promise<AzureCognitiveState> {
    if (managedSettings) {
      apiKey = managedSettings.apiKey;
      region = managedSettings.region;
    }
    if (!apiKey || !region) {
      return {
        settings: null,
        managed: false,
        speechConfig: null,
        localeFilter: false,
        locales: [],
        localeVoices: [],
        voices: [],
        ready: false,
        selectedLocale: null,
        selectedVoice: null,
        selectedStyle: null,
        error: null,
      };
    }

    const cacheKey = `${apiKey}-${region}`;
    const api: AzureCognitiveSettings = { apiKey, region };
    let error = '';
    const voices = await this.voiceCache.getOrCreate(cacheKey, () =>
      this.getVoices(api).catch((err) => {
        error = 'Failed to load voices';
        console.error(err);
        return [];
      }),
    );

    const locales = voices.reduce<string[]>((locales, voice) => {
      if (!localeFilter || LOCALE_SELECTION.has(voice.locale)) {
        if (locales.indexOf(voice.locale) === -1) {
          locales.push(voice.locale);
        }
      }
      return locales;
    }, []);

    const selectedLocale =
      locale ?? locales.find((l) => l === navigator.language) ?? null;
    const selectedVoice = voices.find((v) => v.name === voice) ?? null;
    const localeVoices = voices.filter((v) => v.locale === selectedLocale);

    const speechConfig = await this.speechCache.getOrCreate(cacheKey, () => {
      const speechConfig = SpeechConfig.fromSubscription(
        api.apiKey,
        api.region,
      );
      speechConfig.outputFormat = OutputFormat.Detailed;
      speechConfig.speechSynthesisOutputFormat =
        SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;
      return speechConfig;
    });

    let voiceShortName = null;
    if (selectedVoice) {
      speechConfig.speechSynthesisVoiceName = selectedVoice.name;
      voiceShortName = selectedVoice.shortName;
      if (style && selectedVoice.styleList.indexOf(style) === -1) {
        style = null;
      }
    } else {
      style = null;
    }

    if (selectedLocale) {
      speechConfig.speechRecognitionLanguage = selectedLocale;
    }

    return {
      selectedVoice,
      selectedLocale,
      voices,
      locales,
      localeFilter: !!localeFilter,
      localeVoices,
      selectedStyle: style,
      ready: !!selectedVoice && !!selectedLocale,
      settings: api,
      managed: !!managedSettings,
      speechConfig: {
        speechConfig,
        rate: rate ?? 1,
        style,
        voiceShortName
      },
      error,
    };
  }

  async getVoices(settings: AzureCognitiveSettings) {
    const speech = SpeechConfig.fromSubscription(
      settings.apiKey,
      settings.region,
    );
    const synthAudio = AudioConfig.fromDefaultSpeakerOutput();
    const synth = new SpeechSynthesizer(speech, synthAudio);
    const result = await synth.getVoicesAsync();
    if (result.errorDetails) {
      throw new Error(result.errorDetails);
    }
    return result.voices ?? [];
  }

  async speak(
    speechConfig: AugmentedSpeechConfig,
    deviceId: string,
    rec: Recording,
  ): Promise<SpeakResult> {
    const player = new SpeakerAudioDestination(deviceId);
    const synthAudio = AudioConfig.fromSpeakerOutput(player);
    const synth = new SpeechSynthesizer(speechConfig.speechConfig, synthAudio);
    return new Promise<SpeakResult>((resolve) => {
      const visums: SpeakVisum[] = [];
      synth.visemeReceived = (sender, e) => {
        visums.push({ value: e.visemeId, offset: e.audioOffset / 10000 });
      };
      const rate = rec.rate ?? speechConfig.rate;
      const pm = rate >= 1 ? '+': '';

      // This seemed to work for a bit, then it broke again ?!
      const style_open = speechConfig.style ? `<mstts:express-as style="${speechConfig.style}" styledegree="2">` : '';
      const style_close = speechConfig.style ? `</mstts:express-as>` : '';
      // const style_open = '', style_close = '';
      const lang = speechConfig.voiceShortName?.substring(0, 5);
      const ssml = `
      <speak version="1.0"
          xmlns="http://www.w3.org/2001/10/synthesis"
          xmlns:mstts="https://www.w3.org/2001/mstts"
          xml:lang="${lang}">
        <voice name="${speechConfig.voiceShortName}">
          ${style_open}
            <prosody rate="${pm}${(100*(rate-1)).toFixed(2)}%">
              ${rec.content}
            </prosody>
          ${style_close}
        </voice>
      </speak>`;
      // console.log('ssml', ssml);
      // synth.speakTextAsync(text, (e) => {
      synth.speakSsmlAsync(ssml, (e) => {
        resolve({ duration: e.audioDuration / 10000 - this.speakSuffixDuration, visums }); // ticks to ms
      }, (err) => console.error('speakSsmlAsync err', err));
    });
  }

  listen(speechConfig: AugmentedSpeechConfig, deviceId: string) {
    const defaultMic = AudioConfig.fromMicrophoneInput(deviceId);
    const recognizer = new SpeechRecognizer(speechConfig.speechConfig, defaultMic);
    recognizer.startContinuousRecognitionAsync();
    return recognizer;
  }
}
