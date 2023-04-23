import { Injectable } from '@angular/core';
import { OpenAiService, OpenAIState } from './open-ai.service';
import {
  AzureCognitiveService,
  AzureCognitiveState,
} from './azure-cognitive.service';
import { combineLatest, map, shareReplay } from 'rxjs';
import { DeviceService, DeviceState, MicrophoneState } from './device.service';

export interface ChanDaLiarState {
  none_ready: boolean;
  ready: boolean;
  microphones: MicrophoneState[];
  output: MediaDeviceInfo | null;
  systemMessage: string | null;
}

@Injectable({
  providedIn: 'root',
})
export class ChanDaLiarService {
  state$ = combineLatest([
    this.openAi.state$,
    this.azureCognitive.state$,
    this.device.state$,
  ]).pipe(
    map(([openAi, azureCognitive, device]) =>
      this.mapState(openAi, azureCognitive, device),
    ),
    shareReplay(),
  );

  constructor(
    private openAi: OpenAiService,
    private device: DeviceService,
    private azureCognitive: AzureCognitiveService,
  ) {}

  mapState(
    openAi: OpenAIState,
    azureCognitive: AzureCognitiveState,
    device: DeviceState,
  ): ChanDaLiarState {
    return {
      none_ready: !openAi.ready && !azureCognitive.ready && !device.ready,
      ready: openAi.ready && azureCognitive.ready && device.ready,
      output: device.selectedOutput,
      systemMessage: openAi.rolePlayScript,
      microphones: device.microphones.filter((m) => m.enabled),
    };
  }
}
