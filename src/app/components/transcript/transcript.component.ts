import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnInit,
  ViewChild,
} from '@angular/core';
import {
  faCheck,
  faCheckDouble,
  faFloppyDisk,
  faVolumeHigh,
  faTimes,
} from '@fortawesome/free-solid-svg-icons';
import { SpeakerService } from '../../states/speaker.service';
import {
  CompletedConversationMessage,
  ConversationMessage,
  ConversationService,
} from '../../states/conversation.service';
import { combineLatest, interval } from 'rxjs';
import { PrerecordingService } from 'src/app/states/prerecording.service';
import { AppService } from 'src/app/states/app.service';
import { escapeHtml, generateHtmlDiff } from 'src/app/utils/formatDiff';

@Component({
  selector: 'app-transcript',
  templateUrl: './transcript.component.html',
  styleUrls: ['./transcript.component.scss'],
})
export class TranscriptComponent implements OnInit, AfterViewInit {
  private lastScrolledTo: number | null = null;

  saveIcon = faFloppyDisk;
  speakIcon = faVolumeHigh;
  clearIcon = faTimes;
  checkIcon = faCheck;
  doubleCheckIcon = faCheckDouble;

  @Input()
  systemMessage?: string | null;

  @ViewChild('container')
  container?: ElementRef<HTMLDivElement>;

  @ViewChild('messagelist')
  messageList?: ElementRef<HTMLDivElement>;
  
  conversationId$ = this.conversation.conversationId$;
  settings$ = this.conversation.settings$;
  messages$ = this.conversation.messages$;
  private messageIds: number[] | null = null;
  private sortedMessageIds: number[] | null = null;
  expanded = false;
  developer = false;
  debugMode = false;

  editing: number|null = null;
  needsfocus = false;

  constructor(
    private speaker: SpeakerService,
    private conversation: ConversationService,
    private prerecordings: PrerecordingService,
    app: AppService,
  ) {
    app.state$.subscribe(state => {
      this.developer = state.overrideMode;
      this.debugMode = state.debugMode;
    });
    this.messages$.subscribe(messages => {
      const messageIds = messages.map(m => m.id);
      this.messageIds = [...messageIds];
      messageIds.sort((a, b) => a - b);
      this.sortedMessageIds = messageIds;
    });
  }

  ngOnInit() {
  }

  trackMessage(index: number, message: ConversationMessage) {
    return message.id;
  }

  ngAfterViewInit() {
    combineLatest([this.conversation.highlight$, this.conversation.latestOngoingSubject, interval(100)]).subscribe(([highlight, latestOngoing]) => {

      if (!this.container?.nativeElement) {
        return;
      }

      const id = highlight ? highlight.id : latestOngoing ? latestOngoing.id : null;
      if(!id || this.lastScrolledTo === id) {
        return;
      }

      const part = this.container.nativeElement.querySelector(
        `[data-part-id="${id}"]`,
      );
      if (part) {
        this.lastScrolledTo = id;
        part.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  clear() {
    this.conversation.clear();
  }

  formatCreated(conversationId: number|null) {
    if (!conversationId) return '?';
    const date = new Date(conversationId);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  }

  toggleExpanded() {
    this.expanded = !this.expanded;
  }

  private prefixes = new Set<string>();
  prefixNumber(prefix: string) {
    this.prefixes.add(prefix);
    return this.prefixes.size;
  }

  displayMessage(message: CompletedConversationMessage) {
    if (message.role === "system" && !this.expanded) {
      return message.text.substring(0, 120) + '...';
    }
    return message.text;
  }

  getMessageTitle(message: ConversationMessage) {
    if (message.completed && this.debugMode) {
      return JSON.stringify(message, null, 2);
    } else {
      return "";
    }
  }
  messageHtml(message: CompletedConversationMessage) {
    if ('undefined' === typeof message.originalText) {
      return escapeHtml(message.text);
    }
    return generateHtmlDiff(message.originalText, message.text);
  }

  async savePrerecording(message: CompletedConversationMessage) {
    this.prerecordings.save({
      content: message.text,
      rate: undefined,
    });
  }

  async speakMessage(message: CompletedConversationMessage) {
    this.speaker.push(message.role, {content: message.text, rate: message.rate});
  }

  dump(x: any): string { return JSON.stringify(x); }

  private getId(el: HTMLElement): number {
    const parent = el.closest('[data-part-id]') as HTMLElement;
    const id = parseInt(parent.dataset['partId']!!);
    return id;
  }

  edit(event: MouseEvent) {
    const id = this.getId(event.target as HTMLElement);
    const messages = this.conversation.messagesSubject.value.filter(
      message => message.id === id
    );
    if (!messages.length) {
      console.error('could not find id', id);
      return;
    }
    const message = messages[0] as CompletedConversationMessage;
    if (message.decision === 'open') {
      this.editing = id;
      this.needsfocus = true;
    }
  }

  focus(event: FocusEvent) {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  ngAfterViewChecked() {
    if (this.needsfocus) {
      const container: HTMLElement | undefined = this.container?.nativeElement;
      if (container) {
        const firstTextarea = container.querySelector('textarea');
        firstTextarea?.focus();
        this.needsfocus = false;
      }
    }
  }

  keydown(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      this.editing = null;
      return false;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const el = event.target as HTMLTextAreaElement;
      const id = this.getId(el);
      this.editing = null;
      const text = el.value;
      this.conversation.editMessage(id, text);
      return false;
    }
    return true;
  }

  getSeqId(id: number) {
    return this.sortedMessageIds?.indexOf(id);
  }

  getDelta(i: number) {
    if (i === 0 || !this.messageIds) return '';
    const dtpm = Math.round((this.messageIds[i] - this.messageIds[i - 1]) / 1000);
    const dt = Math.abs(dtpm);
    const pm = dtpm > 0 ? '+' : '-';
    if (dt > 3600) {
      const h = Math.floor(dt / 3600);
      const m = Math.floor((dt - 3600 * h) / 60);
      const s = dt - 3600 * h - 60 * m;
      return `${pm}${h}h${m}m${s}`
    }
    if (dt > 60) {
      const m = Math.floor(dt / 60);
      const s = dt - 60 * m;
      return `${pm}${m}m${s}`
    }
    return `${pm}${dt}s`
  }

}
