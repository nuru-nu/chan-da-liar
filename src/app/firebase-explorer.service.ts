import { Injectable } from '@angular/core';
import { ConversationNotes, ConversationSummary, FirebaseService, FirebaseState, makeConversationKey, parseConversationKey } from './states/firebase.service';
import { BehaviorSubject, combineLatest, mergeMap, shareReplay } from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';
import { CompletedConversation, ConversationService } from './states/conversation.service';
import { RoutedInterface, RouterService } from './router.service';

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
export class FirebaseExplorerService implements RoutedInterface {

  private busy = new BehaviorSubject<boolean>(false);
  private showing = new BehaviorSubject<Set<string>>(new Set());
  private expanded = new BehaviorSubject<Set<string>>(new Set());
  private showArchived = new BehaviorSubject<boolean>(false);
  private showStarred = new BehaviorSubject<boolean>(false);
  private conversations = new BehaviorSubject<Conversation[]>([]);
  initialLoad: boolean = true;

  private initialized = false;

  state$ = combineLatest([
    this.firebase.state$,
    this.busy,
    this.showing,
    this.expanded,
    this.showArchived,
    this.showStarred,
    this.conversations,
  ]).pipe(
    mergeMap(([firebaseState, busy, showing, expanded, showArchived, showStarred, conversations]) =>
      fromPromise(this.mapState(firebaseState, busy, showing, expanded, showArchived, showStarred, conversations))
    ),
    shareReplay(1)
  );

  constructor(
    private firebase: FirebaseService,
    private conversation: ConversationService,
    private router: RouterService,
  ) {
    router.register('explorer', this);
  }

  async refresh() {
    const uids = this.showing.value;
    for (const uid of uids) {
      await this.toggleUser(uid);
    }
    for (const uid of uids) {
      await this.toggleUser(uid);
    }
  }

  private async addConversations(uid: string, conversations: Conversation[]) {
    const summaries = await this.firebase.loadSummaries(uid);
    const notes = await this.firebase.loadNotes(uid);
    const conversationMap = new Map(
      conversations.map(conversation => ([
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
    conversations = [...conversationMap.values()];
    conversations.sort((a, b) => b.id - a.id);
    return conversations;
  }

  private async setShowing(showing: Set<string>) {
    this.busy.next(true);
    const missing = new Set([...showing].filter(s => !this.showing.value.has(s)));
    this.showing.next(showing);
    let conversations = this.conversations.value.filter(c => showing.has(c.uid));
    for (const uid of missing) {
      conversations = await this.addConversations(uid, conversations);
    }
    this.conversations.next(conversations);
    this.busy.next(false);
  }

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
      const conversations = await this.addConversations(uid, this.conversations.value);
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

  async loadConversation(uid: string, id: number) {
    const conversation = await this.firebase.loadConversation(uid, id);
    this.conversation.loadConveration(conversation);
  }

  async toggleStar(uid: string, id: number) {
    await this.updateConversation(uid, id, async (sel: Conversation) => {
      if (!sel.notes) sel.notes = {starred: false};
      await this.firebase.setNote(uid, id, {...sel.notes, starred: !sel.notes.starred});
      sel.notes.starred = !sel.notes.starred;
    });
  }

  async toggleConversation(uid: string, id: number) {
    const uid_id = makeConversationKey(uid, id);
    await this.updateConversation(uid, id, async (sel: Conversation) => {
      if (sel.conversation) {
        delete sel.conversation;
        this.expanded.next(new Set([...this.expanded.value].filter(x => x !== uid_id)));
      } else {
        this.busy.next(true);
        sel.conversation = await this.firebase.loadConversation(uid, id);
        this.expanded.next(new Set([...this.expanded.value, uid_id]));
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
    expanded: Set<string>,
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
            if (showing.size === 0) {
              console.log('initializing uid')
              this.toggleUser(user.id);
            }
          }
        } else {
          ret.users.push(user);
        }
      }
    }
    const kv = new Map<string, string>();
    kv.set('showing', [...showing].join(','));
    kv.set('showArchived', showArchived ? 'yes' : 'no');
    kv.set('showStarred', showStarred ? 'yes' : 'no');
    kv.set('expanded', [...expanded].join(','));
    this.router.update('explorer', kv);
    return ret;
  }

  async loadFromState(kv: Map<string, string>) {
    this.showArchived.next(kv.get('showArchived') === 'yes');
    this.showStarred.next(kv.get('showStarred') === 'yes');
    const showing = new Set(kv.get('showing')!.split(',').filter(s => s));
    await this.setShowing(showing);
    for (const uid_id of kv.get('expanded')!.split(',').filter(s => s)) {
      const { uid, id } = parseConversationKey(uid_id);
      this.toggleConversation(uid, id);
    }
  }

}
