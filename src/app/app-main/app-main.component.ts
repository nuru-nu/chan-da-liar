import {Component, SimpleChanges, ViewContainerRef} from '@angular/core';
import { faGear } from '@fortawesome/free-solid-svg-icons';
import { firstValueFrom, map } from "rxjs";
import { ModalService } from '../modules/modal/modal.service';
import { ConfigurationSidebarComponent } from '../components/configuration-sidebar/configuration-sidebar.component';
import { ChanDaLiarService } from '../states/chan-da-liar.service';
import { OpenAiService } from '../states/open-ai.service';
import { ConversationService } from '../states/conversation.service';
import { OngoingRecognition } from '../states/ongoing-recognizer';
import { AppService } from "../states/app.service";
import { KeyboardService } from '../keyboard';

@Component({
  selector: 'app-app-main',
  templateUrl: './app-main.component.html',
  styleUrls: ['./app-main.component.scss']
})
export class AppMainComponent {
  settingsIcon = faGear;

  state$ = this.chanDaLiar.state$;
  overrideMode$ = this.app.state$.pipe(map(state => state.overrideMode));
  liveEditMode$ = this.app.state$.pipe(map(state => state.overrideMode && state.livePresetEdit))

  expandedPrerecordings: boolean = false;

  constructor(
    private modal: ModalService,
    public viewContainerRef: ViewContainerRef,
    private chanDaLiar: ChanDaLiarService,
    private app: AppService,
    private conversation: ConversationService,
    keyboard: KeyboardService
  ) {
    firstValueFrom(this.state$).then((state) => {
      if (!state.ready) {
        this.openConfigurations(false);
      }
    });
    keyboard.registerExclusive('KeyP', (e: KeyboardEvent) => {
      this.expandedPrerecordings = !this.expandedPrerecordings;
    });
  }

  openConfigurations(canDismiss: boolean) {
    return this.modal.sidebar({
      component: ConfigurationSidebarComponent,
      title: 'Configurations',
      subtitle: 'Credentials and Settings',
      canDismiss,
    });
  }

  spoke(content: OngoingRecognition) {
    this.conversation.pushOngoing(content);
  }

  ngOnChanges(changes: SimpleChanges) {

  }
}
