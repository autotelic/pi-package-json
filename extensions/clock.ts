/**
 * The wall clock, in one place.
 *
 * A duration is wall-clock by definition, so this module is where reading the
 * clock is allowed. Concentrating it here is what lets every other module stay
 * a pure function of its arguments.
 */
export const now = (): number => Date.now();
