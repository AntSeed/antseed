import { getActions, type AppActions } from '../actions';

export function useActions(): AppActions {
  return getActions();
}
