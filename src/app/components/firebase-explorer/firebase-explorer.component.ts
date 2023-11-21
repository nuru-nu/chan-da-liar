import { Component } from '@angular/core';
import { ModalHandle, ModalInstance } from '../../modules/modal/modal.service';
import { FirebaseService } from 'src/app/states/firebase.service';
import { Subject } from 'rxjs';
import { CompletedConversation } from 'src/app/states/conversation.service';

@Component({
  selector: 'app-firebase-explorer',
  templateUrl: './firebase-explorer.component.html',
  styleUrls: ['./firebase-explorer.component.scss']
})
export class FirebaseExplorerComponent implements ModalInstance<void> {
  modal!: ModalHandle<void>;

  private conversations = new Subject<CompletedConversation[]>();
  conversations$ = this.conversations.asObservable();

  constructor(
    private firebase: FirebaseService,
  ) {
    console.log('FirebaseExplorerComponent.constructor');
    this.setup();
  }

  async setup() {
    const conversations = await this.firebase.loadConversations(30);
    this.conversations.next(conversations);
  }

  title(conv: CompletedConversation) {
    const len = conv.length;
    const d = new Date(conv[0].id);
    const secs = (conv[conv.length - 1].id - conv[0].id) / 1000;
    const minutes = Math.round(secs / 6) / 10;
    const date = d.toDateString();
    const time = d.toTimeString().split(' ')[0];
    return `${date} ${time} – ${len} messages - ${minutes} minutes`;
  }
}
