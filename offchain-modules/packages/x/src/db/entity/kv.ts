import { Column, PrimaryGeneratedColumn, Entity, Index } from 'typeorm';

@Entity({ name: 'kv' })
export class KV {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column()
  key: string;

  @Column({ type: 'mediumtext' })
  value: string;
}
