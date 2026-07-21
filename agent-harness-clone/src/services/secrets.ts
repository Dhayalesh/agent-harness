export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
}

export class EnvironmentSecretProvider implements SecretProvider {
  constructor(private readonly prefix = '') {}

  async get(name: string): Promise<string | undefined> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid secret name');
    return process.env[`${this.prefix}${name}`];
  }
}

export class InMemorySecretProvider implements SecretProvider {
  constructor(private readonly values: Readonly<Record<string, string>>) {}

  async get(name: string): Promise<string | undefined> {
    return this.values[name];
  }
}
