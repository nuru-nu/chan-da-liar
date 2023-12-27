import { Component, ViewChild, ViewContainerRef } from '@angular/core';
import { ModalHandle, ModalInstance, ModalService } from '../../modules/modal/modal.service';
import { PrerecordingService, Recording } from '../../states/prerecording.service';
import {
  ConfigurationPrerecordingSidebarComponent
} from '../configuration-prerecording-sidebar/configuration-prerecording-sidebar.component';
import * as Papa from 'papaparse';

@Component({
  selector: 'app-configuration-prerecording-list-sidebar',
  templateUrl: './configuration-prerecording-list-sidebar.component.html',
  styleUrls: ['./configuration-prerecording-list-sidebar.component.scss']
})
export class ConfigurationPrerecordingListSidebarComponent implements ModalInstance<void> {
  state$ = this.prerecording.state$;

  constructor(private prerecording: PrerecordingService,
              private viewContainerRef: ViewContainerRef,
              private modalService: ModalService,) {
  }

  modal!: ModalHandle<void>;

  edit(index:number, rec: Recording) {
    this.modalService.sidebar({
      component: ConfigurationPrerecordingSidebarComponent,
      title: 'Edit prerecording',
      subtitle: 'Prescripted answer',
      props: {
        index,
        recording: rec,
      },
    })
  }

  create() {
    this.modalService.sidebar({
      component: ConfigurationPrerecordingSidebarComponent,
      title: 'Create prerecording',
      subtitle: 'Prescripted answer',
      props: {},
    })
  }

  export() {
    const data = [
      ['content', 'rate'],
    ];
    for(let i = 0; i < this.prerecording.length(); i++) {
      const recording = this.prerecording.get(i);
      data.push([recording.content, (recording.rate || 1).toString()]);
    }
    downloadCSV(data, 'preprecordings.csv');
  }

  async import(event: MouseEvent) {
    const div = (event.target as HTMLElement).closest('div')!;
    const data = await uploadCSV(div);
    if (data[0].length !==2 || data[0][0] !== 'content' || data[0][0] !== 'content') {
      throw new Error('Invalid CSV format');
    }
    const map = new Map<string, number>();
    for (let i = 0; i < this.prerecording.length(); i++) {
      const recording = this.prerecording.get(i);
      map.set(recording.content, i);
    }
    let updated = 0, inserted = 0;
    for (let i = 1; i < data.length; i++) {
      const content = data[i][0];
      const rate = parseFloat(data[i][1]);
      const index = map.get(content);
      if ('undefined' !== typeof index) {
        updated++;
        this.prerecording.edit(index, {
          ...this.prerecording.get(index),
          ...{content, rate}
        });
      } else {
        inserted++;
        this.prerecording.save({content, rate});
      }
    }
    alert(`Added ${inserted} and updated ${updated} prerecordings.`);
  }
}

function downloadCSV(data: string[][], filename: string): void {
  const csvContent = tableToCsvString(data);
  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('download', filename);
  link.setAttribute('href', url);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function uploadCSV(div: HTMLElement): Promise<string[][]> {
  return new Promise((accept) => {
    const input = document.createElement('input');
    input.setAttribute('type', 'file');
    input.setAttribute('accept', '.csv');
    input.setAttribute('multiple', 'false');
    input.style.display = 'none';
    input.addEventListener('change', () => {
      if (input.files && input.files.length > 0) {
        const reader = new FileReader();
        reader.onload = function (e) {
          const csvContent = e.target?.result as string;
          const data = csvStringToTable(csvContent);
          accept(data);
        };
        reader.readAsText(input.files[0]);
      }
      input.remove();
    })
    div.appendChild(input);
    input.click();
  })
}

function csvStringToTable(csvString: string): string[][] {
  const { data } = Papa.parse(csvString, {
      header: false,
      skipEmptyLines: true,
  });
  return data as string[][];
}

function tableToCsvString(table: string[][]): string {
  return Papa.unparse(table);
}
