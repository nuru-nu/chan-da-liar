import { Component } from '@angular/core';
import { ToastsService } from '../toasts.service';

@Component({
  selector: 'app-toasts',
  templateUrl: './toasts.component.html',
  styleUrls: ['./toasts.component.scss']
})
export class ToastsComponent {

  toasts$ = this.toasts.toasts$;

  constructor(
    private toasts: ToastsService
  ) { }

}
