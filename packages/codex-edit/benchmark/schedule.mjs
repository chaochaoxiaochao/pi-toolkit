export function interleaveNeutralAndChallenge(entries, neutralPerChallenge = 4) {
  if (!Number.isInteger(neutralPerChallenge) || neutralPerChallenge < 1) {
    throw new Error("neutralPerChallenge must be a positive integer");
  }
  const neutral = entries.filter((entry) => entry.cohort === "neutral");
  const challenge = entries.filter((entry) => entry.cohort === "challenge");
  const unknown = entries.filter((entry) => !["neutral", "challenge"].includes(entry.cohort));
  if (unknown.length) throw new Error(`Unknown cohort: ${unknown[0].cohort}`);
  if (neutral.length !== challenge.length * neutralPerChallenge) {
    throw new Error(`Expected a ${neutralPerChallenge}:1 neutral/challenge ratio, found ${neutral.length}:${challenge.length}`);
  }

  const scheduled = [];
  for (let index = 0; index < challenge.length; index += 1) {
    scheduled.push(...neutral.slice(index * neutralPerChallenge, (index + 1) * neutralPerChallenge));
    scheduled.push(challenge[index]);
  }
  return scheduled;
}
