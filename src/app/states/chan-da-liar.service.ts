import { Injectable } from '@angular/core';
import { OpenAiService, OpenAIState } from './open-ai.service';
import {
  AzureCognitiveService,
  AzureCognitiveState,
} from './azure-cognitive.service';
import { BehaviorSubject, combineLatest, map, shareReplay } from 'rxjs';
import { DeviceService, DeviceState, MicrophoneState } from './device.service';
import { FirebaseService, FirebaseState } from './firebase.service';

export interface ChanDaLiarState {
  noneReady: boolean,
  ready: boolean;
  microphones: MicrophoneState[];
  output: MediaDeviceInfo | null;
  systemMessage: string | null;
}

@Injectable({
  providedIn: 'root',
})
export class ChanDaLiarService {
  private initialLoad = true;
  state$ = combineLatest([
    this.openAi.state$,
    this.azureCognitive.state$,
    this.device.state$,
    this.firebase.state$,
  ]).pipe(
    map(([openAi, azureCognitive, device, firebase]) =>
      this.mapState(openAi, azureCognitive, device, firebase),
    ),
    shareReplay(1),
  );

  constructor(
    private openAi: OpenAiService,
    private device: DeviceService,
    private azureCognitive: AzureCognitiveService,
    private firebase: FirebaseService,
  ) {}

  isInitialLoad() { return this.initialLoad; }
  setInitialLoad(value: boolean) { this.initialLoad = value; }

  mapState(
    openAi: OpenAIState,
    azureCognitive: AzureCognitiveState,
    device: DeviceState,
    firebase: FirebaseState
  ): ChanDaLiarState {
    return {
      noneReady: !openAi.ready && !azureCognitive.ready && !device.ready && !firebase.ready,
      ready: openAi.ready && azureCognitive.ready && device.ready,
      output: device.selectedOutput,
      systemMessage: openAi.rolePlayScript,
      microphones: device.microphones.filter((m) => m.enabled),
    };
  }
}
