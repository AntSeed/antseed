export type RoutingTrigger = 'request' | 'new-session';

export type RoutingRequestContext = {
  trigger: RoutingTrigger;
};
