import {
  address,
  getAddressEncoder,
  getBytesEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit";
import { PROGRAM_ID } from "./client.ts";

export async function mandatePda(
  owner: string,
  mandateId: number
): Promise<Address> {
  const id = new Uint8Array(8);
  new DataView(id.buffer).setBigUint64(0, BigInt(mandateId), true);
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PROGRAM_ID),
    seeds: [
      getBytesEncoder().encode(new TextEncoder().encode("mandate")),
      getAddressEncoder().encode(address(owner)),
      id,
    ],
  });
  return pda;
}
