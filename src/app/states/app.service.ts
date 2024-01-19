import { Injectable } from "@angular/core";
import { ConfigService } from "../config.service";
import { Observable, combineLatest, map, mergeMap } from "rxjs";

export interface AppState {
  overrideMode: boolean;
  debugMode: boolean
}

@Injectable({
  providedIn: 'root',
})
export class AppService {
  private configOverrideModeKey = 'app-override-mode';
  private configDebugModeKey = 'app-debug-mode';

  state$: Observable<AppState> = combineLatest([
    this.config.watch<boolean>(this.configOverrideModeKey, true),
    this.config.watch<boolean>(this.configDebugModeKey, false),
  ]).pipe(
    map(([overrideMode, debugMode]) => ({
      overrideMode: !!overrideMode,
      debugMode: !!debugMode,
    }))
  );

  setDebugMode(value: boolean) {
    this.config.save(this.configDebugModeKey, value);
  }

  setOverrideMode(value: boolean) {
    this.config.save(this.configOverrideModeKey, value);
  }

  constructor(private config: ConfigService) {}
}
