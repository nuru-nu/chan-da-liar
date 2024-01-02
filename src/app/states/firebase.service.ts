// https://firebase.google.com/docs/reference/js/firestore_lite

import { Injectable } from '@angular/core';
import { ConfigService } from '../config.service';
import { BehaviorSubject, combineLatest, mergeMap, shareReplay} from 'rxjs';
import { fromPromise } from 'rxjs/internal/observable/innerFrom';
import { FirebaseApp, FirebaseError, FirebaseOptions, deleteApp, initializeApp } from "firebase/app";
import {
   getFirestore,
   getDoc,
   updateDoc,
   Firestore,
   collection,
   addDoc,
   doc,
   setDoc,
   getDocs,
   deleteDoc,
   runTransaction,
   query,
   limit,
   Transaction
} from 'firebase/firestore/lite';
import { User, browserLocalPersistence, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { Recording } from "./prerecording.service";
import { CompletedConversation } from './conversation.service';

const DEFAULT_API_KEY = 'AIzaSyCbsk8PYE8siL58giIaDG1BjXLmtNWPjSY';
const DEFAULT_APP_ID = '1:949850774703:web:67bc87b614929fed3a085a';
const DEFAULT_PROJECT_ID = 'chandalair-8bf5b';
const DEFAULT_EMAIL = '';

export interface FirebaseSettings {
  apiKey: string;
  appId: string;
  projectId: string;
  email: string;
  password: string;
}

export interface FirebaseState {
  ready: boolean;
  canLogin: boolean;
  settings: FirebaseSettings;
  loginState: LoginState;
  userSettings: UserSettings;
  allUsers: AllUsers | null;
}

export interface Config {
  azureApiKey: string;
  azureRegion: string;
  openaiApiKey: string;
}

export interface UserSettings {
  id?: string;  // this is also the key in AllUsers
  displayName?: string;
}

export type ConversationKey = string;
export function makeConversationKey(uid: string, id: number) {
  return `${uid}-${id}`;
}
export function parseConversationKey(key: ConversationKey) {
  const [uid, id] = key.split('-');
  return {uid, id: parseInt(id)};
}
function addUidToKey<T>(uid: string, map: Map<number, T>) {
  return new Map([...map.entries()].map(([id, value]) =>
    [makeConversationKey(uid, id), value]
  ));
}
function removeUidFromKey<T>(map: Map<ConversationKey, T>) {
  return new Map([...map.entries()].map(([key, value]) =>
    [parseConversationKey(key).id, value]
  ));
}

function mapToObject<T>(map: Map<number, T>): { [key: string]: T } {
  const obj: { [key: string]: T } = {};
  map.forEach((value, key) => {
      obj[key] = value;
  });
  return obj;
}
function objectToMap<T>(obj: { [key: string]: T }): Map<number, T> {
  return new Map<number, T>([...Object.entries(obj)].map(([k, v]) => [parseInt(k), v]));
}

const SUMMARIES_VERSION = 1;
// users/{uid}/summaries/0
export interface ConversationSummary {
  archived: boolean;
  date: Date;
  minutes: number;
  messages: number;
  words: number;
  deliarMessages: number;
  deliarWords: number;
}

// users/{uid}/notes/0
export interface ConversationNotes {
  title?: string;
  starred?: boolean;
}

// users/{uid}/conversation/{id}
// users/{uid}/archived/{id}
interface Conversation {
  conversation: CompletedConversation;
}

export type AllUsers = Map<string, UserSettings>;

// Login state machine is congtrolled by setting LoginState accordingly.
// See `mapState()`.
export type LoginState = 'load' | 'init' | 'login' | 'wait' | 'success' | 'failure' | 'out';
export type CostSource = 'openai';

function removeUndefined(d: any): any {
  if (Array.isArray(d)) {
    return d.filter(x => 'undefined' !== typeof x).map(removeUndefined);
  }
  if (d !== null && 'object' === typeof d) {
    return Object.fromEntries(
      Object.entries(d).filter(([k, v]) => 'undefined' !== typeof v).map(([k, v]) => [k, removeUndefined(v)])
    );
  }
  return d;
}

@Injectable({
  providedIn: 'root',
})
export class FirebaseService {
  private configApiKey = 'firebase-api-key';
  private configAppIdKey = 'firebase-app-id';
  private configProjectIdKey = 'firebase-project-id';
  private emailKey = 'firebase-email';

  // Documents (relative to /users/<uuid>).
  private configPath = 'info/config';
  private totalsPath = 'info/totals';
  // Collections (relative to /users/<uuid>).
  private costCollection = 'cost';
  private conversationCollection = 'conversation';
  private archiveCollection = 'archive';
  private summariesCollection = 'summaries';
  private notesCollection = 'notes';
  private prerecordingsCollection = 'prerecordings';

  loginState = new BehaviorSubject<LoginState>('load');
  error = new BehaviorSubject<string>('');
  password = new BehaviorSubject<string>('');
  userSettings = new BehaviorSubject<UserSettings>({});
  allUsers = new BehaviorSubject<AllUsers | null>(null);
  private uuid: string|null = null;

  app: FirebaseApp|null = null;
  firestore: Firestore|null = null;

  prerecordings = new BehaviorSubject<Recording[]|null>(null);

  state$ = combineLatest([
    this.config.watch<string>(this.configApiKey, DEFAULT_API_KEY),
    this.config.watch<string>(this.configAppIdKey, DEFAULT_APP_ID),
    this.config.watch<string>(this.configProjectIdKey, DEFAULT_PROJECT_ID),
    this.config.watch<string>(this.emailKey, DEFAULT_EMAIL),
    this.password,
    this.loginState,
    this.userSettings,
    this.allUsers,
  ]).pipe(
    mergeMap(([apiKey, appId, projectId, email, password, loginState, userSettings, allUsers]) =>
      fromPromise(this.mapState(apiKey ?? '', appId ?? '', projectId ?? '', email ?? '', password ?? '', loginState, userSettings, allUsers)),
    ),
    shareReplay(1),
  );

  constructor(private config: ConfigService) {}

  setApiKey(apiKey: string) {
    this.config.save(this.configApiKey, apiKey);
  }
  setAppId(appId: string) {
    this.config.save(this.configAppIdKey, appId);
  }
  setProjectId(projectId: string) {
    this.config.save(this.configProjectIdKey, projectId);
  }
  setEmail(email: string) {
    this.config.save(this.emailKey, email);
  }
  setPassword(password: string) {
    this.password.next(password);
  }

  doLogin() {
    this.nextState('login');
  }
  async doLogout() {
    await signOut(getAuth(this.app!!));
    this.nextState('out');
  }

  private getPath(path: string, uid?: string) {
    return `users/${uid || this.uuid}/${path}`;
  }

  private async initSchema() {
    // Is there a better pattern for this?
    const path = this.getPath(this.totalsPath);
    const totalsRef = doc(this.firestore!, path);
    const totalsSnapshot = await getDoc(totalsRef); ///
    if (!totalsSnapshot.exists()) {
      await setDoc(totalsRef, {created: Date.now(), cost: 0});
    }
  }

  async addCost(cost: number, source: CostSource) {
    if (this.loginState.value != 'success') {
      return;
    }
    const costCol = collection(this.firestore!, this.getPath(this.costCollection));
    const t = Date.now();
    await addDoc(costCol, {t, cost, source});
    // Can this be done in an atomic transaction?
    const totalsRef = await doc(this.firestore!, this.getPath(this.totalsPath));
    const totals = (await getDoc(totalsRef)).data() ?? {};
    await updateDoc(totalsRef, {...totals, t, cost: (totals['cost'] || 0) + cost});
  }

  async getTotalCost() : Promise<number | null> {
    if (this.loginState.value != 'success') {
      return null;
    }
    const totals = (await getDoc(await doc(this.firestore!, this.getPath(this.totalsPath)))).data() ?? {}; ///
    return totals['cost'] as number;
  }

  async getConfig() : Promise<Config|null> {
    if (this.loginState.value != 'success') {
      return null;
    }
    const path = this.getPath(this.configPath);
    const config = (await getDoc(await doc(this.firestore!, path))).data() ?? {}; ///
    if (!config['azureApiKey'] || !config['azureRegion'] || !config['openaiApiKey']) {
      this.error.next(`Invalid config: uuid=${this.uuid} -> config=${JSON.stringify(config)}`);
      this.nextState('failure');
      return null;
    }
    return config as Config;
  }

  async mergePrerecordings(recordings: Recording[]) {
    if (this.loginState.value != 'success') {
      return;
    }
    await runTransaction(this.firestore!, async (transaction) => {
      const coll = collection(this.firestore!, this.getPath(this.prerecordingsCollection));
      const docs = await getDocs(coll);
      const existingRecordings = docs.docs.map(doc => doc.data() as Recording);
      const newRecordings = recordings.filter(r => !existingRecordings.find(e => e.rate === r.rate && e.content === r.content));
      newRecordings.forEach(content => {
        transaction.set(doc(coll), content);
      });
    });
  }

  async deletePrerecording(index:number, recording: Recording) {
    if (this.loginState.value != 'success') {
      return;
    }
    const promises: Promise<void>[] = [];
    (await this.getDocs(this.prerecordingsCollection)).forEach(doc => {
      if (recording.content === doc.data()['content'] && recording.rate === doc.data()['rate']) {
        promises.push(deleteDoc(doc.ref));
      }
    });
    await Promise.all(promises);
  }

  private async getDocs(relativePath: string, limit_?: number, uid?: string) {
    const path = this.getPath(relativePath, uid);
    const coll = collection(this.firestore!, path);
    const snap = await getDocs(
      limit_ ? query(coll, limit(limit_)) : coll);
    return snap.docs;
  }

  private async loadPrerecordings() {
    const docs: Recording[] = [];
    (await this.getDocs(this.prerecordingsCollection)).forEach(doc => {
      const data = doc.data();
      if (typeof data['content'] !== 'string') {
        deleteDoc(doc.ref);
        return;
      }
      docs.push({
        content: data['content'] as string,
        rate: data['rate'] as number | undefined
      });
    });
    this.prerecordings.next(docs);
  }

  private async loadUserSettings() {
    const allUsers: AllUsers = new Map();
    (await getDocs(collection(this.firestore!, 'users'))).forEach(user => {
      allUsers.set(user.id, {id: user.id, ...user.data()});
    });
    this.userSettings.next(allUsers.get(this.uuid!) as UserSettings);
    this.allUsers.next(allUsers);
  }

  async updateUserSettings(displayName?: string) {
    const ref = doc(this.firestore!, `users/${this.uuid}`);
    const userSettings = {...this.userSettings.value};
    if (typeof displayName !== 'undefined') {
      userSettings.displayName = displayName;
    }
    await setDoc(ref, userSettings);
  }

  async setConversation(id: number, conversation: CompletedConversation) {
    if (this.loginState.value != 'success') {
      return;
    }
    const docRef = doc(this.firestore!, this.getPath(`${this.conversationCollection}/${id}`));
    conversation = removeUndefined(conversation);
    const data: Conversation = {conversation};
    await setDoc(docRef, data);
    await this.setSummary(this.uuid!, id, this.summarize(false, conversation));
  }

  private async moveConversation(uid: string, id: number, oldCollection: string, newCollection: string) {
    const oldPath = this.getPath(`${oldCollection}/${id}`, uid);
    const newPath = this.getPath(`${newCollection}/${id}`, uid);
    const oldRef = doc(this.firestore!, oldPath);
    const newRef = doc(this.firestore!, newPath);
    runTransaction(this.firestore!, async (transaction: Transaction) => {
      const oldDoc = await transaction.get(oldRef);
      if (!oldDoc.exists()) throw new Error(`Document ${oldPath} does not exist.`);
      transaction.set(newRef, oldDoc.data());
      transaction.delete(oldRef);
    });
    const summaries = await this.loadSummaries(uid);
    const key = makeConversationKey(uid, id)
    const archived = newCollection === this.archiveCollection;
    summaries.set(key, {...summaries.get(key)!, archived});
    await this.saveSummaries(uid, summaries);
  }

  async archiveConversation(uid: string, id: number) {
    await this.moveConversation(
      uid, id, this.conversationCollection, this.archiveCollection
    );
  }

  async unarchiveConversation(uid: string, id: number) {
    await this.moveConversation(
      uid, id, this.archiveCollection, this.conversationCollection
    );
  }

  async loadConversation(uid: string, id: number): Promise<CompletedConversation> {
    for (const coll of [this.conversationCollection, this.archiveCollection]) {
      const path = this.getPath(`${coll}/${id}`, uid);
      const ref = doc(this.firestore!, path);
      const snap = await getDoc(ref);
      if (snap.exists() && snap.data()) {
        const conversation = snap.data() as Conversation;
        return conversation.conversation;
      }
    }
    throw new Error(`Could not find conversation ${uid}/${id}`);
  }

  async loadConversations(uid: string, archived: boolean = false, limit_?: number): Promise<Map<ConversationKey, CompletedConversation>> {
    return new Map((await this.getDocs(
      archived ? this.archiveCollection : this.conversationCollection, limit_, uid
    )).map(doc => {
      const conversation = doc.data() as Conversation;
      return [
        makeConversationKey(uid, parseInt(doc.id)),
        conversation.conversation,
      ];
    }));
  }

  private summarize(archived: boolean, conv: CompletedConversation): ConversationSummary {
    const date = new Date(conv[0].id);
    const secs = (conv[conv.length - 1].id - conv[0].id) / 1000;
    const minutes = Math.round(secs / 6) / 10;
    const countWords = (messages: CompletedConversation) => messages.map(
       message => (message.text || '').match(/\w+/g)?.length || 0
    ).reduce((prev, cur) => prev + cur, 0);
    const liarConv = conv.filter((message) =>
        message.role === 'assistant');
    const messages = conv.length;
    const words = countWords(conv);
    const deliarMessages = liarConv.length;
    const deliarWords = countWords(liarConv);
    return {archived, date, minutes, messages, words, deliarMessages, deliarWords};
  }

  private async saveSummaries(uid: string, summaries: Map<ConversationKey, ConversationSummary>) {
    const path = this.getPath(`${this.summariesCollection}/0`, uid);
    const ref = doc(this.firestore!, path);
    await setDoc(ref, {
      summaries: mapToObject(removeUidFromKey(summaries)),
      version: SUMMARIES_VERSION,
    });
  }

  async loadSummaries(uid: string, regenerate: boolean = false): Promise<Map<ConversationKey, ConversationSummary>> {
    const path = this.getPath(`${this.summariesCollection}/0`, uid);
    const ref = doc(this.firestore!, path);
    if (regenerate) {
      console.log('regenerating summaries', uid);
      const summaries = new Map([
        ...(await this.loadConversations(uid, false)).entries()
      ].map(([key, conversation]) => ([key, this.summarize(false, conversation)])));
      const archived = new Map([
        ...(await this.loadConversations(uid, true)).entries()
      ].map(([key, conversation]) => ([key, this.summarize(true, conversation)])));
      const combined = new Map([...archived.entries(), ...summaries.entries()]);
      await this.saveSummaries(uid, combined);
      return combined;
    } else {
      const snap = await getDoc(ref);
      const data = snap.data();
      if (data && data['summaries'] && data['version'] === SUMMARIES_VERSION) {
        // `Date` is serialized as `Timestamp`.
        for (const k of Object.keys(data['summaries'])) {
          data['summaries'][k]['date'] = data['summaries'][k]['date'].toDate();
        }
        return addUidToKey(uid, objectToMap(data['summaries']) as Map<number, ConversationSummary>);
      }
      return this.loadSummaries(uid, true);
    }
  }

  async setSummary(uid: string, id: number, summary: ConversationSummary): Promise<Map<ConversationKey, ConversationSummary>> {
    const summaries = await this.loadSummaries(uid);
    summaries.set(makeConversationKey(uid, id), summary);
    await this.saveSummaries(uid, summaries);
    return summaries;
  }

  async loadNotes(uid: string): Promise<Map<ConversationKey, ConversationNotes>> {
    const path = this.getPath(`${this.notesCollection}/0`, uid);
    const ref = doc(this.firestore!, path);
    const snap = await getDoc(ref);
    const data = snap.data();
    if (data && data['notes']) {
      return addUidToKey(uid, objectToMap(data['notes']) as Map<number, ConversationNotes>);
    }
    return new Map();
  }

  async setNote(uid: string, id: number, note: ConversationNotes) {
    const path = this.getPath(`${this.notesCollection}/0`, uid);
    const ref = doc(this.firestore!, path);
    const notes = await this.loadNotes(uid);
    notes.set(makeConversationKey(uid, id), note);
    await setDoc(ref, {notes: mapToObject(removeUidFromKey(notes))});
  }

  private firestoreInit(settings: FirebaseSettings) {
    // Note: this will never fail, even if provided values are invalid.
    const firebaseConfig: FirebaseOptions = {
      apiKey: settings.apiKey,
      authDomain: `${settings.projectId}.firebaseapp.com`,
      projectId: settings.projectId,
      storageBucket: `${settings.projectId}.appspot.com`,
      messagingSenderId: settings.appId!.split(':')[1],
      appId: settings.appId,
    };
    if (this.app) {
      deleteApp(this.app);
      this.app = null;
    }
    this.app = initializeApp(firebaseConfig, 'firebase-service');
    this.firestore = getFirestore(this.app);

    getAuth(this.app).onAuthStateChanged(async (user: User|null) => {
      console.log('onAuthStateChanged', user);
      if (user) {
        this.uuid = user.uid;
        this.initFromDatabase();
      }
    });
  }

  private async initFromDatabase() {
    try {
      await this.initSchema();
      await this.loadPrerecordings();
      await this.loadUserSettings();
    } catch (e) {
      this.nextState('failure');
      const code = (e as FirebaseError).code;
      if (code === 'permission-denied') {
        this.error.next('Permission denied: Could not initialize firestore database. Double check advanced settings and try logging in again.');
        await this.doLogout();
        return;
      }
      throw e;
    }
    this.nextState('success');
  }

  private async firestoreInitAndLogin(settings: FirebaseSettings) {
    console.log('firestoreInitAndLogin');
    // Need to re-initialize firebae because some parameter could have changed.
    this.firestoreInit(settings);
    this.error.next('');
    try {
      const auth = getAuth(this.app!!)
      await auth.setPersistence(browserLocalPersistence);
      await signInWithEmailAndPassword(auth, settings.email, settings.password);
      // => Code will resume in 'onAuthStateChanged' callback if successful/
    } catch (err) {
      console.error('firebase login failure', err);
      this.error.next('Could not login: ' + (err as FirebaseError).message);
      this.nextState('failure');
    }
  }

  private nextState(newState: LoginState) {
    console.log('LoginState', this.loginState.value, '->', newState);
    this.loginState.next(newState);
  }

  async mapState(
    apiKey: string,
    appId: string,
    projectId: string,
    email: string,
    password: string,
    loginState: LoginState,
    userSettings: UserSettings,
    allUsers: AllUsers | null,
  ): Promise<FirebaseState> {

    const settings: FirebaseSettings = {apiKey, appId, projectId, email, password};
    const canLogin = !!(apiKey && appId && projectId);

    if (loginState === 'load') {
      if (canLogin) {
        this.firestoreInit(settings);
        this.nextState('init');
        // If credentials are stored locally, then 'onAuthStateChanged' will
        // update loginState to 'success'.
      }
    }

    else if (loginState === 'login') {
      // If credentials are not stored locally, then user can trigger login.
      this.firestoreInitAndLogin(settings);
      this.nextState('wait');
      // (Again, on success 'onAuthStateChanged' will update to 'success')
    }

    else if (loginState === 'success') {
      this.error.next('');
    }

    return {
      ready: loginState === 'success',
      canLogin,
      settings,
      loginState,
      userSettings,
      allUsers,
    };
  }
}
