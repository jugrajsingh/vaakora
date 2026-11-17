/** The `scrollTop` that puts the mark one line below the top of the view. */
export function followTarget(box: {
  markTop: number;
  lineHeight: number;
}): number {
  return Math.max(0, box.markTop - box.lineHeight);
}

/** Tracks whether the view keeps following the mark or the user has scrolled it away; a new view or read resumes it. */
export function createFollower(): {
  userScrolled(markVisible: boolean): void;
  shouldFollow(): boolean;
  programmatic(): void;
  reset(): void;
  sentenceStarted(start: number): void;
} {
  let following = true;
  let own = false;
  let lastStart = 0;
  return {
    userScrolled(markVisible) {
      if (own) {
        own = false;
        return;
      }
      following = markVisible;
    },
    shouldFollow: () => following,
    programmatic() {
      own = true;
    },
    // A fresh reading view or a new document starts following again.
    reset() {
      following = true;
      own = false;
    },
    // A sentence that starts before the previous one is a new read of the text.
    sentenceStarted(start) {
      if (start < lastStart) {
        following = true;
        own = false;
      }
      lastStart = start;
    },
  };
}
