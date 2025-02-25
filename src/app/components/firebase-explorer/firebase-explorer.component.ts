import { Component, ElementRef, ViewChild } from '@angular/core';
import { ModalHandle, ModalInstance } from '../../modules/modal/modal.service';
import { ConversationKey, ConversationSummary, makeConversationKey } from 'src/app/states/firebase.service';
import { ConversationRole } from 'src/app/states/types';
import { CompletedConversationMessage } from "src/app/states/conversation.service";
import { FirebaseExplorerService, FirebaseExplorerState } from 'src/app/firebase-explorer.service';
import { faEyeSlash, faLink, faPen, faSpinner, faStar as faSolidStar, faEye, faPenToSquare } from '@fortawesome/free-solid-svg-icons';
import { faStar } from '@fortawesome/free-regular-svg-icons';
import { escapeHtml, generateHtmlDiff } from 'src/app/utils/formatDiff';
import { ToastsService } from 'src/app/toasts.service';
import { AppService } from 'src/app/states/app.service';
import { OpenAiService } from 'src/app/states/open-ai.service';

const COLORS_N = 6;
const SYSTEM_ELLIPSIS_LENGTH = 30;

@Component({
  selector: 'app-firebase-explorer',
  templateUrl: './firebase-explorer.component.html',
  styleUrls: ['./firebase-explorer.component.scss'],
})
export class FirebaseExplorerComponent implements ModalInstance<void> {
  modal!: ModalHandle<void>;

  @ViewChild('titleEdit') titleInputRef?: ElementRef;
  needsFocus: boolean = false;

  spinnerIcon = faSpinner;
  starIcon = faStar;
  solidStarIcon = faSolidStar;
  eyeSlashIcon = faEyeSlash;
  eyeIcon = faEye;
  penIcon = faPen;
  penToSquareIcon = faPenToSquare;
  linkIcon = faLink;

  state$ = this.explorer.state$;
  appState$ = this.app.state$;

  private expanded = new Set<ConversationKey>();
  private editingTitle: ConversationKey | null = null;;

  constructor(
    private explorer: FirebaseExplorerService,
    private toasts: ToastsService,
    private app: AppService,
    private openai: OpenAiService,
  ) {
    if (explorer.initialLoad) {
      explorer.initialLoad = false;
    } else {
      explorer.refresh();
    }
  }

  ngAfterViewChecked() {
    if (this.needsFocus) {
      this.titleInputRef?.nativeElement?.focus();
      (this.titleInputRef?.nativeElement as HTMLInputElement).select();
      this.needsFocus = false;
    }
  }

  toggleUser(id: string) { this.explorer.toggleUser(id); }
  userColors = new Map<string, string>();
  getColor(showing: Set<string>, id: string, alwaysColored: boolean, idx?: number) {
    if (!alwaysColored && !showing.has(id)) return 'bg-gray-200';
    if (!this.userColors.has(id)) {
      const color = `color${(idx || 0) % COLORS_N}`;
      this.userColors.set(id, color);
    }
    return this.userColors.get(id);
  }
  toggleShowArchived() {
    this.explorer.toggleShowArchived();
  }
  toggleShowStarred() {
    this.explorer.toggleShowStarred();
  }

  countConversations(state: FirebaseExplorerState) {
    return state.conversations.filter(
      conv =>
        (state.showArchived || !conv.summary?.archived) &&
        (!state.showStarred || conv.notes?.starred)
    ).length;
  }

  toggleConversation(uid: string, id: number) {
    this.explorer.toggleConversation(uid, id);
  }
  getName(users: {id: string, name: string}[], uid: string) {
    return users.filter(u => u.id === uid)[0].name;
  }
  toggleEditTitle(event: MouseEvent | null, uid: string, id: number) {
    event?.stopPropagation();
    const key = makeConversationKey(uid, id);
    if (this.editingTitle === key) {
      this.editingTitle = null;
    } else {
      this.editingTitle = key;
      this.needsFocus = true;
    }
  }
  copyId(event: MouseEvent, uid:string, id: number) {
    event?.stopPropagation();
    navigator.clipboard.writeText(`${uid}-${id}`);
    this.toasts.showToast('Copied to Clipboard!');
  }
  isEditingTitle(uid: string, id: number) {
    return this.editingTitle === makeConversationKey(uid, id);
  }
  async titleKeyDown(event: KeyboardEvent, uid: string, id: number) {
    if (event.key === 'Enter') {
      const target = event.target as HTMLInputElement;
      await this.explorer.setTitle(uid, id, target.value);
      this.toggleEditTitle(null, uid, id);
      event.stopPropagation();
    }
    if (event.key === 'Escape') {
      this.toggleEditTitle(null, uid, id);
      event.stopPropagation();
    }
  }
  async loadConversation(event: MouseEvent, uid: string, id: number) {
    event.stopPropagation();
    await this.explorer.loadConversation(uid, id);
    this.modal.dismiss();
  }
  toggleStar(event: MouseEvent, uid: string, id: number) {
    event.stopPropagation();
    this.explorer.toggleStar(uid, id);
  }
  toggleConversationArchived(event: MouseEvent, uid: string, id: number) {
    event.stopPropagation();
    this.explorer.toggleConversationArchived(uid, id);
  }
  fmtSummary1(summary: ConversationSummary) {
    const date = new Date(summary.date);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()} – ${Math.round(10 * summary.minutes) / 10} minutes`
  }
  fmtSummary2(summary: ConversationSummary) {
    const maybeDelay = summary.maxDelayMs ? ` – delay ⌀${summary.averageDelayMs}ms (max ${summary.maxDelayMs})` : '';
    let model = summary.settings?.model || '?';
    if (summary.settings?.props) {
      const formattedProps = this.openai.formatProps(summary.settings.props);
      if (formattedProps) {
        model += ` (${formattedProps})`;
      }
    }
    return `${model} – ${summary.messages} messages / ${summary.words} words (Deliar ${summary.deliarMessages}/${summary.deliarWords})${maybeDelay}`;
  }
  isExpanded(uid: string, id: number) {
    return this.expanded.has(makeConversationKey(uid, id));
  }
  toggleExpanded(uid: string, id: number) {
    if (this.expanded.has(makeConversationKey(uid, id))) {
      this.expanded.delete(makeConversationKey(uid, id))
    } else {
      this.expanded.add(makeConversationKey(uid, id))
    }
  }
  ellipsis(message: string) {
    const words = message.split(' ');
    if (words.length <= SYSTEM_ELLIPSIS_LENGTH) return message;
    return words.slice(0, 30).join(' ') + '...';
  }
  isEllipsable(message: string) {
    return message.split(' ').length > SYSTEM_ELLIPSIS_LENGTH;
  }
  getRoleTitle(message: CompletedConversationMessage, debug: boolean) {
    if (debug) {
      return JSON.stringify(message, null, 2);
    } else {
      return "";
    }
  }
  fmtRole(role: ConversationRole) {
    return {
      'assistant': 'Deliar',
      'user': 'Human',
      'system': 'System',
    }[role];
  }
  private prefixes = new Set<string>();
  prefixNumber(prefix: string) {
    this.prefixes.add(prefix);
    return this.prefixes.size;
  }
  messageHtml(message: CompletedConversationMessage) {
    if ('undefined' === typeof message.originalText) {
      return escapeHtml(message.text);
    }
    return generateHtmlDiff(message.originalText, message.text);
  }
}
