import { Injectable } from '@angular/core';
import { BehaviorSubject, combineLatest, firstValueFrom, map, Observable, Subject, Subscription } from 'rxjs';
import { OpenAiService, OpenAIState, PromptMessage } from './open-ai.service';
import { ConversationRole, Recording } from './types';
import { OngoingRecognition } from './ongoing-recognizer';
import { SpeakerService } from './speaker.service';
import { FirebaseService } from './firebase.service';
import { KeyboardService } from '../keyboard';

export type Decision = 'yes' | 'skip' | 'open';

export type CompletedConversation = CompletedConversationMessage[];

export interface CompletedConversationMessage {

  completed: true;

  id: number;
  role: ConversationRole;
  prefix: string | null;
  text: string;
  rate?: number;

  // If different from final text (override -> originalText='').
  originalText?: string;

  decision: Decision;
  highlight: boolean;
  queued: boolean;
  played: boolean;
  editing?: boolean;

  model?: string;
  initialDelayMs?: number;
}

// This mirrors OngoingRecognition in ./ongoing-recognizer.ts
export interface OngoingConversationMessage {
  completed: false;

  id: number;
  role: ConversationRole;
  textPrefix?: string;
  text$: Observable<string>;
  rate: number | undefined;
}

interface OngoingConversationRecognition {
  recognition: OngoingRecognition;
  subscription: Subscription;
}

export type ConversationMessage =
  | OngoingConversationMessage
  | CompletedConversationMessage;

export interface ConversationSettings {
  model: string|null;
  parent?: number;
  // LLAMA_CPP - {default_generation_settings: {model, n_ctx, ...}}
  // OLLAMA - {details: {family, format, parameter_size, quantization_level}}
  props?: string;
}

const nows = new Set();
const uniqueNow = () => {
  let now = Date.now();
  while (nows.has(now)) now++;
  nows.add(now);
  return now;
};

class MessageBuilder {
  private message: CompletedConversationMessage;
  constructor(text: string, role: ConversationRole) {
    this.message = {
      completed: true,

      id: uniqueNow(),
      role,
      prefix: null,
      text,
      rate: undefined,

      decision: 'open',
      highlight: false,
      queued: false,
      played: false,
      editing: false,
    };
  }
  rate(rate?: number): MessageBuilder {
    this.message.rate = rate;
    return this;
  }
  prefix(prefix: string|null): MessageBuilder {
    this.message.prefix = prefix;
    return this;
  }
  initialDelayMs(initialDelayMs: number|null): MessageBuilder {
    if (initialDelayMs) {
      this.message.initialDelayMs = initialDelayMs;
    }
    return this;
  }
  yes(): MessageBuilder {
    this.message.decision = 'yes';
    return this;
  }
  override(): MessageBuilder {
    this.message.originalText = '';
    return this;
  }
  build(): CompletedConversationMessage {
    return this.message;
  }
}


@Injectable({
  providedIn: 'root'
})
export class ConversationService {
  messagesSubject = new BehaviorSubject<ConversationMessage[]>([]);
  // `highlight` should always point to the first open message, and there should
  // only be open messages after the highlight.
  highlightSubject = new BehaviorSubject<CompletedConversationMessage | null>(
    null
  );
  latestOngoingSubject = new BehaviorSubject<OngoingConversationMessage | null>(null);
  private conversationIdSubject = new BehaviorSubject<number>(Date.now());
  conversationId$ = this.conversationIdSubject.asObservable();
  private ongoingConversations: OngoingConversationRecognition[] = [];
  pushed = new Subject<void>();

  settings = new BehaviorSubject<ConversationSettings>({model: null});
  settings$ = this.settings.asObservable();

  messages$ = this.messagesSubject.asObservable();
  promptMessages$ = this.messages$.pipe(
    map(messages => this.getPromptMessages(messages)));
  tokens$ = this.promptMessages$.pipe(
    map(messages => this.openAI.countTokens(JSON.stringify(messages)))
  );

  highlight$ = this.highlightSubject.asObservable();
  selectedModel = '?';

  constructor(
    private openAI: OpenAiService,
    private speaker: SpeakerService,
    keyboard: KeyboardService,
    firebase: FirebaseService
  ) {
    this.openAI.state$.subscribe((state) => {
      this.clear(state);
      this.settings.next({
        ...this.settings.value,
        model: state.selectedModel?.id || null,
        ...(state.props ? {props: state.props} : {}),
      });
    });

    this.messages$.subscribe((messages) => {
      if (messages.length > 1) {
        const conversation = messages.filter(message => message.completed) as CompletedConversation;
        firebase.setConversation(this.conversationIdSubject.value, this.settings.value, conversation);
      }
    });

    keyboard.registerExclusive('Space', (e: KeyboardEvent) => this.decide('yes', e.shiftKey, e.ctrlKey));
    keyboard.registerExclusive('Enter', (e: KeyboardEvent) => this.maybeAcceptAllThenPrompt(e.shiftKey));
    keyboard.registerExclusive('Backspace', (e: KeyboardEvent) => e.ctrlKey ? this.delete(e.shiftKey) : this.decide('skip', e.shiftKey));
    keyboard.registerExclusive('ArrowUp', (e: KeyboardEvent) => this.undecide());
    keyboard.registerExclusive('KeyS', (e: KeyboardEvent) => this.split(e.shiftKey));
    keyboard.registerExclusive('KeyM', (e: KeyboardEvent) => this.merge(e.shiftKey));
    keyboard.registerExclusive('KeyQ', (e: KeyboardEvent) => this.toggleRegie());
  }

  private toggleRegie() {
    const highlight = this.highlightSubject.value;
    if (!highlight || !highlight.completed || highlight.role !== 'user') return;
    let text = highlight.text;
    const m = text.match(/(.*)(\[[^\]]+\])/);
    const regies = [
      '[sarcasm]',
      '[dry humour]',
      '[angry]',
    ];
    if (m) {
      const idx = regies.indexOf(m[2]);
      text = `${m[1]}${regies[(idx + 1) % regies.length]}`;
    } else {
      text = `${text} ${regies[0]}`;
    }
    const messages = this.messagesSubject.value;
    const idx = messages.findIndex(m => m.id === highlight.id);
    messages[idx] = {...(messages as CompletedConversationMessage[])[idx], text};
    this.nextMessages(messages);
  }

  private split(toTheEnd?: boolean) {
    const highlight = this.highlightSubject.value;
    if (!highlight || !highlight.completed) return;
    const m = highlight.text.match(/^(.*\S{2}[.?!])\s+(\S.*)/)
    if (!m) return;
    highlight.text = m[1];
    const ids = new Set(this.messagesSubject.value.map(m => m.id));
    let nextId = highlight.id + 1;
    while (ids.has(nextId)) nextId++;
    const nextMessage = {
      ...highlight,
      id: nextId,
      originalText: undefined,
      text: m[2],
      highlight: false,
    };
    const messages = this.messagesSubject.value;
    const idx = messages.findIndex(m => m.id === highlight.id);
    messages.splice(idx + 1, 0, nextMessage);
    this.highlightSubject.next(highlight);
    this.messagesSubject.next(messages);
    if (toTheEnd) this.split(toTheEnd);
  }

  private merge(toTheEnd?: boolean) {
    const highlight = this.highlightSubject.value;
    if (!highlight || !highlight.completed) return;
    const messages = this.messagesSubject.value;
    const idx = messages.findIndex(m => m.id === highlight.id);
    if (idx + 1 >= messages.length) return;
    const nextMessage = messages[idx + 1];
    if (!nextMessage.completed) return;
    if (highlight.role !== nextMessage.role) return;
    highlight.text += ' ' + nextMessage.text;
    delete highlight.originalText;
    messages.splice(idx + 1, 1);
    this.highlightSubject.next(highlight);
    this.messagesSubject.next(messages);
    if (toTheEnd) this.merge(toTheEnd);
  }

  private delete(toTheEnd?: boolean) {
    const highlight = this.highlightSubject.value;
    if (!highlight || !highlight.completed) return;
    const messages = this.messagesSubject.value;
    const idx = messages.findIndex(m => m.id === highlight.id);
    messages.splice(idx, 1);
    let nextHighlight = null;
    if (idx < messages.length && messages[idx].completed) {
      nextHighlight = messages[idx] as CompletedConversationMessage;
      nextHighlight.highlight = true;
      nextHighlight.queued = nextHighlight.played = false;
      nextHighlight.decision = 'open';
    }
    this.messagesSubject.next(messages);
    this.highlightSubject.next(nextHighlight);
    if (toTheEnd && nextHighlight && nextHighlight.completed) {
      this.delete(toTheEnd);
    }
  }

  private maybeAcceptAllThenPrompt(firstAcceptAll?: boolean) {
    if (firstAcceptAll) {
      while (this.highlightSubject.value && this.highlightSubject.value.completed) {
        this.decide('yes');
      }
    }

    const highlight = this.highlightSubject.value;
    const messages = this.messagesSubject.value;
    const insertAt =
      highlight === null
      ? messages.length
      : messages.findIndex(message => message.id === highlight.id);
    const promptMessages = this.getPromptMessagesUntil(this.messagesSubject.value, insertAt - 1);
    this.openAI.prompt(promptMessages).then(recognition => {
      this.pushOngoing(recognition, insertAt);
    });
  }

  private decide(decision: Decision, toTheEnd?: boolean, skipReading?: boolean) {
    const message = this.highlightSubject.value;
    if (message) {
      message.decision = decision;
      if (message.role === 'assistant' && decision === 'yes') {
        if (skipReading) {
          message.played = true;
        } else {
          this.queue(message);
        }
      }
      this.nextMessages(this.messagesSubject.value);
      if (toTheEnd) this.decide(decision, toTheEnd, skipReading);
    }
  }

  private undecide() {
    const messages = this.messagesSubject.value;
    const highlight = this.highlightSubject.value;
    const idx = highlight ? messages.findIndex(m => m.id === highlight.id) : messages.length;
    if (idx < 1) return;
    const previous = messages[idx - 1];
    if (previous.completed) {
      previous.decision = 'open';
      this.nextMessages(messages);
    }
  }

  async clear(state?: OpenAIState) {
    if (!state) {
      state = await firstValueFrom(this.openAI.state$);
    }

    this.setConversationId(Date.now());
    this.settings.next({...this.settings.value, parent: 0})
    this.nextMessages(
      state.rolePlayScript ? [new MessageBuilder(state.rolePlayScript, 'system').yes().build()] : []
    );
    this.ongoingConversations = [];
  }

  private getPromptMessagesUntil(messages: ConversationMessage[], untilIndex: number): PromptMessage[] {
    const promptMessages: PromptMessage[] = [];
    for (let i = 0; i <= untilIndex && i < messages.length; i++) {
      const message = messages[i];
      if (message.completed && message.decision === 'yes') {
        promptMessages.push({
          content: !!message.prefix ? `${message.prefix}${message.text}` : message.text,
          role: message.role
        });
      }
    }
    return promptMessages;
  }

  private setConversationId(id: number) {
    this.conversationIdSubject.next(id);
    const messages = this.messagesSubject.value;
    if (messages.length) {
      // Make sure ID can be read from first message.
      const delta = id - messages[0].id;
      this.messagesSubject.next(
        messages.map(message => ({...message, id: message.id + delta}))
      );
    }
  }

  loadConveration(conversation: CompletedConversation) {
    this.settings.next({...this.settings.value, parent: conversation[0].id})
    this.nextMessages(conversation);
    this.setConversationId(Date.now());  // Order matters!
  }

  private nextMessages(messages: ConversationMessage[]) {
    let highlight = null;
    for (const message of messages) {
      if (message.completed) {
        if (message.decision === 'open') {
          message.played = message.queued = false;
          message.highlight = false;
          if (highlight === null) {
            message.highlight = true;
            highlight = message;
          }
        } else {
          message.highlight = false;
        }
      }
    }
    this.messagesSubject.next(messages);
    this.highlightSubject.next(highlight);
  }

  editMessage(id: number, text: string) {
    const messages = this.messagesSubject.value;
    const index = messages.findIndex(message => message.id === id);
    if (index === -1) throw new Error(`Could not find message id=${id}`);
    const message = messages[index];
    if (!message.completed) throw new Error('Cannot only edit completed message');
    if (message.decision !== 'open') throw new Error('Can only edit "open" message');
    if (!message.originalText) message.originalText = message.text;
    message.text = text;
    messages[index] = message;
    this.messagesSubject.next(messages);
  }

  private getPromptMessages(messages: ConversationMessage[]): PromptMessage[] {
    return this.getPromptMessagesUntil(messages, messages.length - 1);
  }

  private pushMessage(message: CompletedConversationMessage) {
    const lastDecisionIndex = this.messagesSubject.value.findIndex(m => !m.completed || m.decision === 'open');
    if (lastDecisionIndex >= 0) {
      this.messagesSubject.value.splice(lastDecisionIndex, 0, message);
    } else {
      this.messagesSubject.value.push(message);
    }
    this.nextMessages(this.messagesSubject.value);
    this.pushed.next();
  }

  pushAssistant(recording: Recording) {
    const newMessage = new MessageBuilder(recording.content, 'assistant').rate(recording.rate).override().build();
    this.pushMessage(newMessage);
  }

  pushUser(recording: Recording) {
    const newMessage = new MessageBuilder(recording.content, 'user').override().rate(recording.rate).build();
    this.pushMessage(newMessage);
  }

  queue(message: CompletedConversationMessage) {
    message.queued = true;
    this.nextMessages(this.messagesSubject.value);

    this.speaker.push(message.role, {content: message.text, rate: message.rate}).then(() => {
      message.played = true;
      this.nextMessages(this.messagesSubject.value);
    });
  }

  pushOngoing(recognition: OngoingRecognition, insertAt?: number) {
    const ongoingMessage: OngoingConversationMessage = {
      id: Date.now(),
      rate: recognition.rate,
      text$: recognition.text$,
      completed: false,
      role: recognition.role
    };

    const ongoingConversation: OngoingConversationRecognition = {
      recognition,
      subscription: combineLatest([
        recognition.completed, recognition.initialDelayMs,
      ]).subscribe(([completed, initialDelayMs]) => {
        const message = new MessageBuilder(completed, recognition.role)
            .prefix(recognition.textPrefix ?? null)
            .initialDelayMs(initialDelayMs)
            .build();
        const ongoingIndex = this.messagesSubject.value.indexOf(ongoingMessage);
        this.messagesSubject.value.splice(ongoingIndex, 0, message);
        this.nextMessages(this.messagesSubject.value);
      }),
    };

    this.latestOngoingSubject.next(ongoingMessage)
    this.ongoingConversations.push(ongoingConversation);
    this.messagesSubject.value.splice(insertAt ?? this.messagesSubject.value.length, 0, ongoingMessage);
    this.nextMessages(this.messagesSubject.value);

    recognition.end.then(() => {
      ongoingConversation.subscription?.unsubscribe();
      const index = this.ongoingConversations.indexOf(ongoingConversation);
      this.ongoingConversations.splice(index, 1);
      if(this.latestOngoingSubject.value === ongoingMessage) {
        this.latestOngoingSubject.next(null)
      }
      const ongoingIndex = this.messagesSubject.value.indexOf(ongoingMessage);
      this.messagesSubject.value.splice(ongoingIndex, 1);
      this.nextMessages(this.messagesSubject.value);
    });
  }
}
