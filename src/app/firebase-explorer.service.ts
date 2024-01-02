import { Injectable } from '@angular/core';
import { ConversationNotes, ConversationSummary, FirebaseService, FirebaseState, makeConversationKey, parseConversationKey } from './states/firebase.service';
import { BehaviorSubject, combineLatest, mergeMap, shareReplay } from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';
import { CompletedConversation } from './states/conversation.service';

interface Conversation {
    uid: string;
    id: number;
    notes?: ConversationNotes;
    summary?: ConversationSummary,
    conversation?: CompletedConversation,
}

export interface FirebaseExplorerState {
  busy: boolean;
  showing: Set<string>;
  showArchived: boolean;
  showStarred: boolean;
  users?: {id: string, name: string}[];  // first is self

  conversations: Conversation[];
}

@Injectable({
  providedIn: 'root'
})
export class FirebaseExplorerService {

  private busy = new BehaviorSubject<boolean>(false);
  private showing = new BehaviorSubject<Set<string>>(new Set());
  private showArchived = new BehaviorSubject<boolean>(false);
  private showStarred = new BehaviorSubject<boolean>(false);
  private conversations = new BehaviorSubject<Conversation[]>([]);

  private initialized = false;

  state$ = combineLatest([
    this.firebase.state$,
    this.busy,
    this.showing,
    this.showArchived,
    this.showStarred,
    this.conversations,
  ]).pipe(
    mergeMap(([firebaseState, busy, showing, showArchived, showStarred, conversations]) =>
      fromPromise(this.mapState(firebaseState, busy, showing, showArchived, showStarred, conversations))
    ),
    shareReplay(1)
  );

  constructor(private firebase: FirebaseService) {}

  async toggleUser(uid: string) {
    const showing = new Set(this.showing.value);
    if (showing.has(uid)) {
      showing.delete(uid);
      this.conversations.next(this.conversations.value.filter(
        conversation => conversation.uid !== uid
      ));
    } else {
      showing.add(uid);
      this.busy.next(true);
      const summaries = await this.firebase.loadSummaries(uid);
      const notes = await this.firebase.loadNotes(uid);
      const conversationMap = new Map(
        this.conversations.value.map(conversation => ([
          makeConversationKey(conversation.uid, conversation.id),
          conversation
        ]))
      );
      for (const key of [...notes.keys(), ...summaries.keys()]) {
        if (!conversationMap.has(key)) {
          conversationMap.set(key, {...parseConversationKey(key)});
        }
      }
      for(const [key, summary] of summaries.entries()) {
        conversationMap.get(key)!.summary = summary;
      }
      for(const [key, note] of notes.entries()) {
        conversationMap.get(key)!.notes = note;
      }
      const conversations = [...conversationMap.values()];
      conversations.sort((a, b) => a.id - b.id);
      this.conversations.next(conversations);
      this.busy.next(false);
    }
    this.showing.next(showing);
  }
  toggleShowArchived() {
    this.showArchived.next(!this.showArchived.value);
  }
  toggleShowStarred() {
    this.showStarred.next(!this.showStarred.value);
  }

  private async updateConversation(uid: string, id: number, update: (arg1: Conversation) => Promise<void>) {
    const conversations = [...this.conversations.value];
    const sel = conversations.filter(
      conversation => conversation.uid === uid && conversation.id === id
    )[0];
    await update(sel);
    this.conversations.next(conversations);
  }

  async setTitle(uid: string, id: number, title: string) {
    await this.updateConversation(uid, id, async (sel: Conversation) => {
      if (!sel.notes) sel.notes = {starred: false};
      await this.firebase.setNote(uid, id, {...sel.notes, title});
      sel.notes.title = title;
    });
  }

  async toggleStar(uid: string, id: number) {
    await this.updateConversation(uid, id, async (sel: Conversation) => {
      if (!sel.notes) sel.notes = {starred: false};
      await this.firebase.setNote(uid, id, {...sel.notes, starred: !sel.notes.starred});
      sel.notes.starred = !sel.notes.starred;
    });
  }

  async toggleConversation(uid: string, id: number) {
    await this.updateConversation(uid, id, async (sel: Conversation) => {
      if (sel.conversation) {
        delete sel.conversation;
      } else {
        this.busy.next(true);
        sel.conversation = await this.firebase.loadConversation(uid, id);
        this.busy.next(false);
      }
    });
  }

  async toggleConversationArchived(uid: string, id: number) {
    this.updateConversation(uid, id, async (conv) => {
      if (conv.summary!.archived) {
        await this.firebase.unarchiveConversation(uid, id);
        conv.summary!.archived = false;
      } else {
        await this.firebase.archiveConversation(uid, id);
        conv.summary!.archived = true;
      }
    });
  }

  private async mapState(
    firebaseState: FirebaseState,
    busy: boolean,
    showing: Set<string>,
    showArchived: boolean,
    showStarred: boolean,
    conversations: Conversation[],
  ): Promise<FirebaseExplorerState> {
    const ret: FirebaseExplorerState = {
      busy,
      showing,
      showArchived,
      showStarred,
      conversations,
    };
    if (!firebaseState.ready) {
      ret.busy = true;
      return ret;
    }
    if (firebaseState.allUsers) {
      ret.users = [];
      for (const [id, setting] of firebaseState.allUsers.entries()) {
        const user = {
          id,
          name: setting.displayName || `User ${id.substring(0, 4)}`,
        };
        if (user.id === firebaseState.userSettings.id) {
          ret.users.unshift(user);
          if (!this.initialized) {
            this.initialized = true;
            this.toggleUser(user.id);
          }
        } else {
          ret.users.push(user);
        }
      }
    }
    return ret;
  }
}
