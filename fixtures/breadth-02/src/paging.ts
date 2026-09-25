import { PAGE_SIZE } from './pageSize.ts';

export function pageCount(total: number): number {
  return Math.ceil(total / PAGE_SIZE);
}

// Last-page check for the pager controls.
export function isLastPage(page: number, totalPages: number): boolean {
  return page > totalPages - 1;
}
