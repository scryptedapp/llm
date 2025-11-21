import type { AbstractLevel } from 'abstract-level';
import { Level } from "level";
import path from 'path';

export class Database {
    constructor(public level: AbstractLevel<any, string>) {
    }

    async get<T>(key: string): Promise<T | undefined> {
        const ret = await this.level.get(key);
        if (!ret)
            return;
        return JSON.parse(ret);
    }
    async sublevel(sublevelName: string): Promise<Database> {
        return new Database(this.level.sublevel(sublevelName));
    }
    private async _iterate<V>(
        filterFn: (value: any) => boolean,
        properties?: string[]
    ): Promise<{ key: string; value: Partial<V> }[]> {
        const result: { key: string; value: Partial<V> }[] = [];
        
        for await (const [key, str] of this.level.iterator()) {
            const value = await JSON.parse(str);
            
            // Apply filter function
            if (!filterFn(value)) {
                continue;
            }
            
            // Apply property filtering if specified
            if (properties?.length) {
                const filteredValue: Partial<V> = {};
                for (const property of properties) {
                    if (value[property] !== undefined) {
                        filteredValue[property as keyof V] = value[property];
                    }
                }
                result.push({ key, value: filteredValue });
            } else {
                result.push({ key, value });
            }
        }
        
        return result;
    }
    
    async getAll<V>(options?: {
        properties?: string[];
    }): Promise<{
        key: string,
        value: Partial<V>,
    }[]> {
        return this._iterate(() => true, options?.properties);
    }
    
    async search<V>(options: {
        search: string;
        searchProperties: string[];
        properties?: string[];
    }): Promise<{
        key: string,
        value: Partial<V>,
    }[]> {
        const searchTerm = options.search.toLowerCase();
        
        return this._iterate(
            (value) => {
                // Check if any of the search properties contain the search term (case insensitive)
                return options.searchProperties.some(property => {
                    const propertyValue = value[property];
                    return typeof propertyValue === 'string' && 
                           propertyValue.toLowerCase().includes(searchTerm);
                });
            },
            options.properties
        );
    }
    
    put(key: string, value: any): Promise<void> {
        return this.level.put(key, JSON.stringify(value));
    }
    delete(key: string): Promise<void> {
        return this.level.del(key);
    }

    deleteAll(): Promise<void> {
        return this.level.clear();
    }

    async putProperty(key: string, property: string, value: any): Promise<void> {
        const str = await this.level.get(key) as string;
        const existingValue = JSON.parse(str) || {};
        existingValue[property] = value;
        await this.put(key, existingValue);
    }

    async spliceProperty(key: string, property: string, start: number, deleteCount?: number, ...items: any[]): Promise<void> {
        const str = await this.level.get(key) as string;
        const value = JSON.parse(str);
        if (!value) {
            return;
        }

        if (!Array.isArray(value[property])) {
            throw new Error(`Property ${property} is not an array.`);
        }

        value[property].splice(start, deleteCount || 0, ...items);
        await this.put(key, value);
    }
}

export interface UserDatabase {
    openDatabase(token: string): Promise<Database>;
}

export class UserLevel extends Level {
    constructor(userId: string) {
        super(path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, userId));
    }
}
