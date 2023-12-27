import { Injectable } from '@angular/core';
import { combineLatest, debounceTime, map, shareReplay } from 'rxjs';
import { ConfigService } from '../config.service';

export interface LightState {
  serverAddress: string
  ready: boolean
}

@Injectable({providedIn: 'root'})
export class LightService {
  private serverAddressKey = 'light-server-address';
  serverAddress: string | null = null;

  constructor(private config: ConfigService) {}

  state$ = combineLatest([
    this.config.watch<string>(this.serverAddressKey, 'http:///localhost:8080'),
  ]).pipe(
    debounceTime(500),
    map(([arnet]) =>
      this.mapState(arnet),
    ),
    shareReplay(1),
  );

  setServerIp(ip: string) {
    this.config.save(this.serverAddressKey, ip);
  }

  private mapState(serverAddress: string | null): LightState {
    this.serverAddress = serverAddress;
    return {
      ready: true,
      serverAddress: serverAddress!!,
    }
  }

  async send(body: any) {
    if (this.serverAddress) {
      await fetch(this.serverAddress, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }).catch(e => {
        console.log('Could not send to light:', e.message);
      });
    }
  }
}
