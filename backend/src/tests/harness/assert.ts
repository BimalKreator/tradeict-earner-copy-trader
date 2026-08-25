/** Records each assertion so the runner report shows checks run, not just "passed". */
export class AssertionContext {
  private count = 0;

  get assertionCount(): number {
    return this.count;
  }

  assert(condition: boolean, message: string): void {
    if (!condition) {
      throw new Error(message);
    }
    this.count += 1;
  }

  equal<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
      throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
    }
    this.count += 1;
  }

  near(actual: number, expected: number, label: string, epsilon = 0.0001): void {
    if (Math.abs(actual - expected) > epsilon) {
      throw new Error(
        `${label}: expected ~${expected}, got ${actual} (epsilon=${epsilon})`,
      );
    }
    this.count += 1;
  }
}
