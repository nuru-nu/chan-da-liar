import { Component, ViewChild } from '@angular/core';
import { ModalHandle } from '../../modules/modal/modal.service';
import { ConfigService } from '../../config.service';
import {
  AzureCognitiveService,
  AzureCognitiveState,
} from '../../states/azure-cognitive.service';
import { SpeakerService } from '../../states/speaker.service';
import { FirebaseService } from 'src/app/states/firebase.service';
import { map } from 'rxjs';
import { InputComponent } from '../input/input.component';

@Component({
  selector: 'app-configuration-firebase-sidebar.component',
  templateUrl: './configuration-firebase-sidebar.component.html',
  styleUrls: ['./configuration-firebase-sidebar.component.scss'],
})
export class ConfigurationFirebaseComponent {

  modal!: ModalHandle<void>;
  state$ = this.firebase.state$;
  error = this.firebase.error;
  loginState = this.firebase.loginState;
  showAdvanced = false;
  userSettingsChanged = false;
  userName?: string;

  constructor(
    private config: ConfigService,
    private speaker: SpeakerService,
    private firebase: FirebaseService
  ) {}

  setApiKey(apiKey: string) {
    this.firebase.setApiKey(apiKey);
  }

  setAppId(appId: string) {
    this.firebase.setAppId(appId);
  }

  setProjectId(projectId: string) {
    this.firebase.setProjectId(projectId);
  }

  setEmail(email: string) {
    this.firebase.setEmail(email);
  }

  setPassword(password: string) {
    this.firebase.setPassword(password);
  }

  userNameChanged(userName: string) {
    this.userName = userName;
    this.userSettingsChanged = true;
  }

  async updateSettings() {
    await this.firebase.updateUserSettings(this.userName);
    this.userSettingsChanged = false;
  }

  doLogin() {
    this.firebase.doLogin();
  }

  doLogout() {
    this.firebase.doLogout();
  }
}
