export interface Product {
  sku: string;
  qty: number;
}

export interface Order {
  id: string;
  paid: boolean;
  shipped: boolean;
}
