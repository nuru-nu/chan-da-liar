import { Component } from '@angular/core';
import { ModalHandle } from '../../modules/modal/modal.service';
import {
  DeviceService,
  MicrophoneState,
} from '../../states/device.service';
import { ConversationRole } from 'src/app/states/types';
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';

@Component({
  selector: 'app-configuration-device-sidebar',
  templateUrl: './configuration-device-sidebar.component.html',
  styleUrls: ['./configuration-device-sidebar.component.scss'],
})
export class ConfigurationDeviceSidebarComponent {
  triangleExclamation = faTriangleExclamation;
  modal!: ModalHandle<void>;
  state$ = this.device.state$;
  errorMessage = '';
  isChrome: boolean = window.navigator.userAgent.indexOf('Chrome/') !== -1;

  constructor(private device: DeviceService) {}

  async requestPermission() {
    try {
      await navigator.mediaDevices.getUserMedia({audio: true})
      this.device.setPermission();
      this.errorMessage = '';
    } catch (err) {
      console.error(err);
      this.errorMessage = err as string;
    }
  }

  identify(index: number, item: MicrophoneState) {
    return item.deviceId;
  }

  setOutput(deviceId: string) {
    this.device.setOutput(deviceId);
  }

  updateRole(input: MicrophoneState, role: ConversationRole) {
    this.device.updateRole(input, role)
  }

  toggleInput(input: MicrophoneState, evt: Event) {
    const elm = evt.target as HTMLInputElement;
    this.device.toggleInput(input, elm.checked);
  }

  updatePrefix(input: MicrophoneState, name: string) {
    this.device.updatePrefix(input, name);
  }
}
