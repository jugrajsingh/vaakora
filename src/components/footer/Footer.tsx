import React from "react";

import type { Link } from "@/lib/navigation";
import { ActivityStatus } from "./ActivityStatus";
import NoticeChip from "./NoticeChip";

interface FooterProps {
  navigate: (link: Link) => void;
}

const Footer: React.FC<FooterProps> = ({ navigate }) => {
  return (
    <footer className="flex h-[36px] w-full shrink-0 items-center justify-between gap-3 border-t border-line px-4 text-xs">
      <ActivityStatus navigate={navigate} />
      <NoticeChip />
    </footer>
  );
};

export default Footer;
