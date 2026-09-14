const BASE_MS = 200;
const CAP_MS = 5_000;

// Full jitter (the AWS variant): each empty claim doubles a ceiling from 200ms toward 5s, and the
// actual sleep is a uniform draw over [0, ceiling) — so a fleet of idle workers spreads its polls
// instead of thundering in lockstep, and a queue that just went quiet is re-checked cheaply.
export class IdleBackoff {
  private misses = 0;

  constructor(private readonly random: () => number = Math.random) {}

  nextDelayMs(): number {
    const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** this.misses);
    if (ceiling < CAP_MS) this.misses += 1;
    return Math.floor(this.random() * ceiling);
  }

  reset(): void {
    this.misses = 0;
  }
}
