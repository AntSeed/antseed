export type HeadlineBalanceState = {
  creditsTotalOwnedUsdc: string;
};

/** The buyer's complete owned balance, including USDC awaiting deposit sweep. */
export function selectHeadlineBalanceUsdc(state: HeadlineBalanceState): string {
  return state.creditsTotalOwnedUsdc;
}
