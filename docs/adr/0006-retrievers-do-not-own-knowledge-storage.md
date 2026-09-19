# Retrievers do not own Knowledge storage

The Framework owns the Knowledge database and never exposes it to custom Retrievers. A custom Retriever may keep only external, rebuildable state, and a Vector store preserves the Framework's opaque vector IDs unchanged. This gives up arbitrary colocated Retriever tables so Framework migrations can change the Knowledge schema without turning its layout into public API.
