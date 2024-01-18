import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface Toast {
  id: number;
  text: string;
  active: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class ToastsService {

  toastsSubject = new BehaviorSubject<Toast[]>([]);
  toasts$ = this.toastsSubject.asObservable();
  id = 0;

  showToast(text: string) {
    const id = this.id++;
    this.toastsSubject.next([...this.toastsSubject.value, {
      id, text, active: true}]);
    window.setTimeout(() => {
      const toasts = [...this.toastsSubject.value];
      for (const toast of toasts) {
        if (toast.id === id) {
          toast.active = false;
        }
      }
      this.toastsSubject.next(toasts);
    }, 1000);
    window.setTimeout(() => {
      this.toastsSubject.next(this.toastsSubject.value.filter(t => t.id !== id));
    }, 2000);
  }
}
