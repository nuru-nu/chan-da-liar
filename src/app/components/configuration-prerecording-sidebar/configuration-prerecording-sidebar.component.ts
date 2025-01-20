import { Component, Input, OnInit, ViewChild } from '@angular/core';
import { ModalHandle, ModalInstance } from '../../modules/modal/modal.service';
import { PrerecordingService } from "../../states/prerecording.service";
import { Recording } from 'src/app/states/types';
import { TextareaComponent } from '../textarea/textarea.component';

@Component({
  selector: 'app-configuration-prerecording-sidebar',
  templateUrl: './configuration-prerecording-sidebar.component.html',
  styleUrls: ['./configuration-prerecording-sidebar.component.scss'],
})
export class ConfigurationPrerecordingSidebarComponent
  implements OnInit, ModalInstance<void>
{
  modal!: ModalHandle<void>;
  editMode = false;

  @ViewChild(TextareaComponent)
  transcript?: TextareaComponent;

  @Input()
  recording: Recording = {content: '', rate: 1};

  @Input()
  index?: number;

  constructor(private prerecording: PrerecordingService) {}

  ngOnInit() {
    this.editMode =
      this.index !== null && this.index !== undefined && this.index >= 0;
  }

  create() {
    if (!this.transcript || !this.transcript.value) {
      return;
    }

    if (this.index !== null && this.index !== undefined && this.index >= 0) {
      this.prerecording.edit(this.index, this.recording);
    } else {
      this.prerecording.save(this.recording);
    }
    this.modal.dismiss();
  }
}
