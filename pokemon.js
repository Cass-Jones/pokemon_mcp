const cache = new Map(); 
const CACHE_LIMIT = 500;

export async function getPokemon(nameOrId) {
    const key = nameOrId.trim().toLowerCase();

    if (!/^[a-z0-9-]{1,100}$/.test(key)) {
        throw new Error(
            "Use a Pokemon name or ID (1-100 characters, lowercase letters, numbers, and hyphens only)."
        );
    }

    if (cache.has(key)) {
        return cache.get(key);
    }

    const response = await fetch(
        `https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(key)}`,
        {signal: AbortSignal.timeout(10000)}
    );

    if (response.status === 404) {
        throw new Error(`Pokemon not found: ${key}`);
    }

    if (!response.ok) {
        throw new Error(`Failed to fetch Pokemon data: ${response.status}`);
    }

    const pokemon = await response.json();

    const result = {
        id: pokemon.id,
        name: pokemon.name,
        types: pokemon.types.map((typeInfo) => typeInfo.type.name),
        height: pokemon.height,
        weight: pokemon.weight,
        abilities: pokemon.abilities.map((abilityInfo) => abilityInfo.ability.name),
        base_stats:Object.fromEntries(
            pokemon.stats.map((statInfo) => [statInfo.stat.name, statInfo.base_stat])
        )
    }

    // Bound memory use by removing the oldest cached entry.
    if (cache.size >= CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
    }

    cache.set(key, result);
    return result;
}