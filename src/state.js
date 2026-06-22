/* ============================== [STATE] ==============================
   Shared mutable game state.  Singletons live here so any module can read
   or mutate them.  `refs.human` and `vm.current` are reassignable handles
   (held in objects so import bindings stay live across modules).          */
import { TEAM } from './data.js';

export const agents = [];
export const refs = { human: null };       // the local player (set in buildTeams)
export const vm = { current: null };       // first-person weapon viewmodel
export const clock = { t: 0 };             // wall-clock seconds (advanced by main loop)

export const GAME = {
  phase: "warmup",       // warmup | idle | buy | live | end | matchend | editor | frozen
  round: 1, half: 1, scoreCT: 0, scoreT: 0,
  humanTeam: TEAM.CT, ctIsHuman: true,
  lossStreak: { CT: 0, T: 0 }, timer: 0, freeze: 0, thirdPerson: false,
  hostages: [], rescued: 0, winner: null, roundResult: "",
  customMap: null,       // active custom map data, or null for cs_office
};

export const FREEZE_TIME = 12, ROUND_TIME = 115, END_TIME = 5;

export const keys = {};
export const input = { mouseDown: false, rmbDown: false };
