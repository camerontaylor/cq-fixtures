import { describe, expect, it } from 'vitest';
import { sortTasks, type Task } from '../src/sortTasks.ts';

// Behavioral spec for sortTasks: tasks render highest-priority first, and
// equal priorities fall back to ascending id. Every case below mixes
// distinct priorities so the ordering direction itself is exercised.
describe('sortTasks', () => {
  it('orders by priority descending', () => {
    const tasks: Task[] = [
      { id: 2, priority: 1, label: 'sweep' },
      { id: 1, priority: 5, label: 'deploy' },
      { id: 3, priority: 1, label: 'audit' },
    ];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('breaks priority ties by ascending id, below higher priorities', () => {
    const tasks: Task[] = [
      { id: 9, priority: 9, label: 'release' },
      { id: 4, priority: 2, label: 'lint' },
      { id: 7, priority: 2, label: 'docs' },
    ];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual([9, 4, 7]);
  });

  it('returns a new array and leaves the input unmutated', () => {
    const tasks: Task[] = [
      { id: 1, priority: 3, label: 'write' },
      { id: 2, priority: 8, label: 'ship' },
    ];
    const sorted = sortTasks(tasks);
    expect(sorted.map((t) => t.id)).toEqual([2, 1]);
    expect(tasks.map((t) => t.id)).toEqual([1, 2]);
  });
});
