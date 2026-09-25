# Code-defined Agents follow the code

A Scope runs the current code definition of a code-defined Agent. The Scope stores nothing for it, and the code definition has version 0. A Spec that the Scope stores with the same `agentId` is an Override, and the Scope runs the Override until a delete removes it.

Before, the first Turn in a Scope stored a copy of the code definition. The Scope then kept that copy, thus a deploy did not reach a Scope that had already run the Agent. We did not keep that model, because each Scope then ran the code of the day of its first Turn. A Platform that must keep one Scope on a definition stores it as an Override.

A Turn does not check the code definition against the Scope. It applies the Scope ceilings to it, in the same way as to a stored Spec. Thus a lower ceiling in one Scope limits a code-defined Agent and does not stop it.
