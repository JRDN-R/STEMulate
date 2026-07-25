declare module "lucide-react/dist/esm/icons/*.mjs" {
  import type { ForwardRefExoticComponent, RefAttributes, SVGProps } from "react";

  const Icon: ForwardRefExoticComponent<
    Omit<SVGProps<SVGSVGElement>, "ref"> & {
      size?: number | string;
      absoluteStrokeWidth?: boolean;
    } & RefAttributes<SVGSVGElement>
  >;

  export default Icon;
}
