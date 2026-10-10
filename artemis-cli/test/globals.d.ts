// Tests poke at loosely-typed JSON responses; let `res.json()` be `any` here.
interface Response { json(): Promise<any> }
