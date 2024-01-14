import { Injectable } from '@angular/core';
import { ModalService } from './modules/modal/modal.service';
import { FirebaseExplorerComponent } from './components/firebase-explorer/firebase-explorer.component';
import { RouterService } from './router.service';

@Injectable({
  providedIn: 'root'
})
export class UtilsService {

  private router?: RouterService;

  constructor(
    private modal: ModalService,
  ) { }

  registerRouter(router: RouterService) {
    this.router = router;
  }

  openExplorer() {
    this.modal.sidebar({
      component: FirebaseExplorerComponent,
      title: 'Firebase Explorer',
      subtitle: 'Explore data in firestore database.',
      classNames: ['fullscreen'],
      canDismiss: true,
    }).then(() => {
      this.router?.clear();
    });
  }
}
