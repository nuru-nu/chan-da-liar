import { Injectable } from '@angular/core';
import { ConfigService } from '../config.service';
import { combineLatest, mergeMap, shareReplay } from 'rxjs';
import {Cache} from '../utils/cache';
import { ConversationRole } from './types';

export interface DeviceState {
  hasPermission: boolean
  outputs: MediaDeviceInfo[];
  inputs: MediaDeviceInfo[];

  microphones: MicrophoneState[];
  selectedOutput: MediaDeviceInfo | null;
  ready: boolean;
}

export interface MicrophoneState {
  name: string;
  deviceId: string;
  deviceName: string;
  enabled: boolean;
  prefix?: string
  role: ConversationRole
}


@Injectable({
  providedIn: 'root',
})
export class DeviceService {
  private outputKey = 'device-output-speaker';
  private microphoneKey = 'device-input-microphones';
  private mediaPermissionKey = 'media-permission';

  private mediaCache = new Cache<MediaDeviceInfo[]>()

  state$ = combineLatest([
    this.config.watch<boolean>(this.mediaPermissionKey),
    this.config.watch<string>(this.outputKey),
    this.config.watch<MicrophoneState[]>(this.microphoneKey),
  ]).pipe(
    mergeMap(([permissions, outputId, microphones]) =>
      this.mapState(permissions, outputId, microphones),
    ),
    shareReplay(1),
  );

  constructor(private config: ConfigService) {

  }

  setPermission() {
    this.config.save(this.mediaPermissionKey, true)
  }

  async getInputDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(
      (d) => d.kind === 'audioinput' && d.deviceId !== 'default',
    );
  }

  async getOutputDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(
      (d) => d.kind === 'audiooutput' && d.deviceId !== 'default',
    );
  }

  setOutput(deviceId: string) {
    this.config.save(this.outputKey, deviceId);
  }

  toggleInput(device: MicrophoneState, checked: boolean) {
    this.updateMicrophoneState(device, (mic) => {
      mic.enabled = checked;
    });
  }

  updateRole(device: MicrophoneState, role: ConversationRole) {
    this.updateMicrophoneState(device, (mic) => {
      mic.role = role;
    });
  }

  updatePrefix(device: MicrophoneState, name: string) {
    this.updateMicrophoneState(device, (mic) => {
      mic.prefix = name;
    });
  }

  private updateMicrophoneState(
    device: MicrophoneState,
    update: (state: MicrophoneState) => void,
  ) {
    const mics = this.config.get<MicrophoneState[]>(this.microphoneKey) || [];
    let mic = mics.find((m) => m.deviceId === device.deviceId);
    if (!mic) {
      mic = {
        enabled: device.enabled,
        name: device.name,
        deviceName: device.deviceName,
        deviceId: device.deviceId,
        prefix: device.prefix,
        role: device.role,
      };
      mics.push(mic);
    }

    update(mic);
    this.config.save(this.microphoneKey, mics);
  }

  private async mapState(
    permission: boolean | null,
    outputId: string | null,
    microphoneStates: MicrophoneState[] | null,
  ): Promise<DeviceState> {
    if (!permission) {
      return {
        inputs: [],
        outputs: [],
        hasPermission: false,
        microphones: [],
        selectedOutput: null,
        ready: false,
      }
    }

    const inputs = await this.mediaCache.getOrCreate('inputs', () => this.getInputDevices())
    const outputs = await this.mediaCache.getOrCreate('outputs', () => this.getOutputDevices())

    const selectedOutput = outputs.find((o) => o.deviceId === outputId) ?? null;

    const states: MicrophoneState[] = [];
    for (const input of inputs) {
      const microphoneState = microphoneStates?.find(
        (s) => s.deviceId === input.deviceId,
      );
      if (microphoneState) {
        states.push({
          ...microphoneState,
          role: microphoneState.role ?? 'user',
        });
      } else {
        states.push({
          deviceId: input.deviceId,
          prefix: '',
          enabled: true,
          deviceName: input.label,
          name: input.label,
          role: 'user',
        });
      }
    }

    return {
      hasPermission: true,
      inputs,
      outputs,
      selectedOutput,
      microphones: states,
      ready: !!selectedOutput && states.length > 0,
    };
  }
}
