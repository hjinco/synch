export interface AuthSessionTokenStore {
  read(): Promise<string>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}
