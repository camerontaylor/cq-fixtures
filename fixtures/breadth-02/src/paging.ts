import { PAGE_SIZE } from './pageSize.ts';

export function pageCount(total: number): number {
  return Math.ceil(total / PAGE_SIZE);
}

// True when `page` is the zero-based index of the final page.
export function isLastPage(page: number, totalPages: number): boolean {
  return page > totalPages - 1;
}
