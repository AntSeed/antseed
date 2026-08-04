export class UsdcBudget {
  private spent: bigint
  private reserved = 0n
  private nextTicket = 0
  private readonly reservations = new Map<number, bigint>()

  constructor(
    private readonly maximum: bigint,
    initialSpent = 0n,
  ) {
    if (maximum < 0n) throw new Error('maximum USDC budget cannot be negative')
    if (initialSpent < 0n) throw new Error('initial USDC spend cannot be negative')
    if (initialSpent > maximum) throw new Error('initial USDC spend exceeds benchmark maximum')
    this.spent = initialSpent
  }

  reserve(maximumRequestCharge: bigint): number {
    if (maximumRequestCharge < 0n) throw new Error('request charge reservation cannot be negative')
    if (this.spent + this.reserved + maximumRequestCharge > this.maximum) {
      throw new Error('benchmark USDC budget exhausted')
    }

    const ticket = this.nextTicket++
    this.reservations.set(ticket, maximumRequestCharge)
    this.reserved += maximumRequestCharge
    return ticket
  }

  commit(ticket: number, actualCharge: bigint): bigint {
    const reserved = this.requireTicket(ticket)
    if (actualCharge < 0n) throw new Error('seller charge cannot be negative')
    if (actualCharge > reserved) {
      throw new Error('seller charge exceeded reserved per-request maximum')
    }

    this.reservations.delete(ticket)
    this.reserved -= reserved
    this.spent += actualCharge
    return this.spent
  }

  release(ticket: number): void {
    const reserved = this.requireTicket(ticket)
    this.reservations.delete(ticket)
    this.reserved -= reserved
  }

  getSpent(): bigint {
    return this.spent
  }

  getAvailable(): bigint {
    return this.maximum - this.spent - this.reserved
  }

  private requireTicket(ticket: number): bigint {
    const value = this.reservations.get(ticket)
    if (value === undefined) throw new Error('unknown budget reservation')
    return value
  }
}
