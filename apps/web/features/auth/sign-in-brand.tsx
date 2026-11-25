import Image from 'next/image';
import Link from 'next/link';

export function SignInBrand() {
  return (
    <Link href="/" aria-label="Watchrail home" className="sign-in-brand">
      <Image src="/watchrail-mark.svg" alt="" width={30} height={30} className="sign-in-logo" />
      <span className="sign-in-product">
        watchrail<span aria-hidden="true">.</span>
      </span>
    </Link>
  );
}
