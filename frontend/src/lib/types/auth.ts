import type { Role, UUID } from "./common";

/** `POST /auth/login`, `POST /auth/refresh` (livrés par le socle). */
export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

/** `GET /me` (livré par le socle). */
export interface Me {
  id: UUID;
  email: string;
  full_name: string;
  role: Role;
}
