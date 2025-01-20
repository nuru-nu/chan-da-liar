import { Component, ViewChild } from '@angular/core';
import { ConversationService } from '../../states/conversation.service';
import { InputComponent } from '../input/input.component';
import { PrerecordingService } from "src/app/states/prerecording.service";
import { Recording } from 'src/app/states/types';
import { AppService } from 'src/app/states/app.service';
import { map } from 'rxjs';
import { AzureCognitiveService } from 'src/app/states/azure-cognitive.service';
import { KeyboardService } from 'src/app/keyboard';

@Component({
  selector: 'app-override-lane',
  templateUrl: './override-lane.component.html',
  styleUrls: ['./override-lane.component.scss'],
})
export class OverrideLaneComponent {

  destination: string = 'bot';
  value: string = '';

  @ViewChild('input', {static: false})
  input?: InputComponent;

  rate$ = this.azureCognitive.state$.pipe(map(state => state.speechConfig?.rate ?? 1.0));
  styles$ = this.azureCognitive.state$.pipe(map(state => state.selectedVoice?.styleList ));
  selectedStyle$ = this.azureCognitive.state$.pipe(map(state => state.selectedStyle ));

  constructor(
    private conversation: ConversationService,
    private app: AppService,
    private azureCognitive: AzureCognitiveService,
    private prerecordings: PrerecordingService,
    keyboard: KeyboardService,
  ) {
    keyboard.registerExclusive('KeyO', () => this.input?.focusInput());
    prerecordings.editable.subscribe((content: Recording) => {
      if (content && this.input) {
        this.input.value = content.content;
        this.input?.focusInput();
        this.setRate(content.rate ?? 1);
      }
    });
    conversation.pushed.subscribe(() => this.clear());
  }

  valueChanged(value: string) {
    this.value = value;
    this.prerecordings.currentFilter.next(this.value);
  }

  private clear() {
    this.valueChanged('');
    this.input?.blurInput()
  }

  keyDown(keyCode: string) {
    if (keyCode === 'Enter') {
      if (this.value) {
        if (this.destination === 'bot') {
          this.conversation.pushAssistant({content: this.value});
        } else if (this.destination === 'user') {
          this.conversation.pushUser({content: this.value});
        }
      }
      this.clear();
    }
    if (keyCode === 'Tab') {
      this.destination = ({
        'bot': 'user',
        'user': 'bot',
      }[this.destination])!;
    }
  }

  setStyle(style: string) {
    this.azureCognitive.setStyle(style);
  }

  setRate(rate: number) {
    this.azureCognitive.setRate(rate);
  }
}
