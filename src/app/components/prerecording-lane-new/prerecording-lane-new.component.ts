import { Component } from '@angular/core';
import {
  PrerecordingService,
} from '../../states/prerecording.service';
import { Recording } from 'src/app/states/types';
import { ConversationService } from '../../states/conversation.service';

@Component({
  selector: 'app-prerecording-lane-new',
  templateUrl: './prerecording-lane-new.component.html',
  styleUrls: ['./prerecording-lane-new.component.scss']
})
export class PrerecordingLaneNewComponent {

  state$ = this.prerecording.state$;

  constructor(
    private prerecording: PrerecordingService,
    private conversation: ConversationService,
  ) {}

  async select(rec: Recording) {
    this.conversation.pushAssistant(rec);
  }

  visible(currentFilter: string, rec: Recording) {
    const words = currentFilter.toLocaleLowerCase().split(/\s+/);
    for (const word of words) {
      if (rec.content.toLowerCase().indexOf(word) === -1) {
        return false;
      }
    }
    return true;
  }

}
