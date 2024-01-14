import { Injectable } from '@angular/core';
import { ModalService } from './modules/modal/modal.service';
import { FirebaseExplorerComponent } from './components/firebase-explorer/firebase-explorer.component';

export interface RoutedInterface {
  loadFromState(kv: Map<string, string>): void;
}

interface Pending {
  name: string;
  kv: Map<string, string>;
}

@Injectable({
  providedIn: 'root'
})
export class RouterService {

  private routed = new Map<string, RoutedInterface>();
  private initialHash?: string;
  private pending: Pending[] = []

  constructor(
    private modal: ModalService,
  ) {
    const [_, initialHash] = window.location.href.split('#', 2);
    this.initialHash = initialHash;
  }

  register(name: string, routed: RoutedInterface) {
    this.routed.set(name, routed);
    this.pending = this.pending.filter(pending => {
      if (pending.name !== name) return true;
      routed.loadFromState(pending.kv);
      return false;
    });
  }

  update(name: string, kv: Map<string, string>) {
    const e = (s: string) => encodeURIComponent(s).replace('%2C', ',');
    if (kv.has('name')) throw new Error('"name" is reserved when constructing route');
    window.location.href = window.location.href.split('#')[0] + `#name=${e(name)}&` + (
      [...kv.entries()].map(([k, v]) => `${e(k)}=${e(v)}`)
    ).join('&');
  }

  private enqueue(pending: Pending) {
    if (this.routed.has(pending.name)) {
      this.routed.get(pending.name)!.loadFromState(pending.kv);
    } else {
      this.pending.push(pending);
    }
  }

  loadFromInitialState() {
    if (this.initialHash) {
      const kv = new Map<string, string>();
      for (const s of this.initialHash.split('&')) {
        const [k, v] = s.split('=', 2).map(decodeURIComponent);
        kv.set(k, v);
      }
      const name = kv.get('name');
      kv.delete('name');
      if (name === 'explorer') {
        this.modal.sidebar({
          component: FirebaseExplorerComponent,
          title: 'Firebase Explorer',
          subtitle: 'Explore data in firestore database.',
          classNames: ['fullscreen'],
          canDismiss: true,
        });
        this.enqueue({name, kv});
      } else {
        throw new Error(`Unknown route: ${name}`);
      }
    }
  }
}
