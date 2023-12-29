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
   limit
} from 'firebase/firestore/lite';
import { User, browserLocalPersistence, getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { Recording } from "./prerecording.service";
import { CompletedConversation, CompletedConversationMessage } from './conversation.service';

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
  // user: User | null;
}

export interface Config {
  azureApiKey: string;
  azureRegion: string;
  openaiApiKey: string;
}

export interface UserSettings {
  displayName?: string;
}

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
  private prerecordingsCollection = 'prerecordings';

  loginState = new BehaviorSubject<LoginState>('load');
  error = new BehaviorSubject<string>('');
  password = new BehaviorSubject<string>('');
  userSettings = new BehaviorSubject<UserSettings>({});
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
  ]).pipe(
    mergeMap(([apiKey, appId, projectId, email, password, loginState, userSettings]) =>
      fromPromise(this.mapState(apiKey ?? '', appId ?? '', projectId ?? '', email ?? '', password ?? '', loginState, userSettings)),
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

  private getPath(path: string) {
    return `users/${this.uuid}/${path}`;
  }

  private async initSchema() {
    // Is there a better pattern for this?
    const path = this.getPath(this.totalsPath);
    const totalsRef = await doc(this.firestore!, path);
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

  async setConversation(id: string, conversation: any) {
    if (this.loginState.value != 'success') {
      return;
    }
    const docRef = await doc(this.firestore!, this.getPath(`${this.conversationCollection}/${id}`));
    conversation = removeUndefined(conversation);
    await setDoc(docRef, {conversation});
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

  private async getDocs(relativePath: string, limit_?: number) {
    const path = this.getPath(relativePath);
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
    const settings = await getDoc(await doc(this.firestore!, `users/${this.uuid}`));
    this.userSettings.next(settings.data() as UserSettings);
  }

  async updateUserSettings(displayName?: string) {
    const ref = await doc(this.firestore!, `users/${this.uuid}`);
    const userSettings = {...this.userSettings.value};
    if (typeof displayName !== 'undefined') {
      userSettings.displayName = displayName;
    }
    await setDoc(ref, userSettings);
  }

  async loadConversations(limit_?: number): Promise<CompletedConversation[]> {
    return (await this.getDocs(this.conversationCollection, limit_)).map(doc => {
      return doc.data()['conversation'] as CompletedConversation;
    });
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
    };
  }
}
