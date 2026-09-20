export interface Address {
  city: string;
}

export interface Profile {
  name: string;
  address?: Address;
}
