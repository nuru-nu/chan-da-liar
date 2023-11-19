import { Component } from '@angular/core';
import { ModalHandle, ModalInstance } from '../../modules/modal/modal.service';

@Component({
  selector: 'app-firebase-explorer',
  templateUrl: './firebase-explorer.component.html',
  styleUrls: ['./firebase-explorer.component.scss']
})
export class FirebaseExplorerComponent implements ModalInstance<void> {
  modal!: ModalHandle<void>;
}
